// dev tool: dump the EXACT scene JSON the live plugin feeds the shared viewer core —
// for EVERY scene in the test world — so the web demo (cfg-core-browser
// /dev-vtt-viewer, parity-scenes.json) renders identical payloads (true side-by-side
// parity) with a scene picker. Regenerates that tracked fixture. Canonicalizes the CFG
// 3D Test scene first: token positions reset to seed values, duplicate notes removed,
// slice OFF (full dollhouse — all levels, unclipped walls).
//
//   node tests/integration/dump-parity-scene.mjs
import { writeFileSync } from 'node:fs'
import { chromium } from '@playwright/test'
import { ensureInGame } from './shared/foundry-login.mjs'

const URL = process.env.FOUNDRY_URL || 'http://localhost:30000'
const OUT = '/Users/personal/Projects/Crit-Fumble/workspaces/cfg-core-browser/src/app/dev-vtt-viewer/parity-scenes.json'

const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext({ baseURL: URL })).newPage()
try {
  await ensureInGame(page)
  await page.evaluate(async () => {
    const s = game.scenes.find((x) => x.name === 'CFG 3D Test')
    if (s && !s.active) await s.activate()
  })
  await page.waitForFunction(() => globalThis.canvas?.ready === true, { timeout: 60_000 })
  await page.waitForFunction(() => !!window.CFGCore?.overlay3D, { timeout: 30_000 })

  // Canonicalize the test scene (it must be active for embedded-doc updates via canvas).
  await page.evaluate(async () => {
    const SEED = {
      'Center (friendly)': { x: 1450, y: 1450, elevation: 0 },
      'Giant (neutral, 2x2)': { x: 1650, y: 1600, elevation: 0 },
      'Tree (GLB model)': { x: 1150, y: 1650, elevation: 0 },
      'Flier (Ground +15ft)': { x: 1300, y: 1550, elevation: 15 },
      'Upstairs flier (+30ft)': { x: 1500, y: 1300, elevation: 30 },
      'Burrower (Ground -15ft)': { x: 1600, y: 1450, elevation: -15 },
    }
    const updates = []
    for (const doc of canvas.scene.tokens) {
      const s = SEED[doc.name]
      if (s) updates.push({ _id: doc.id, ...s })
    }
    if (updates.length) await canvas.scene.updateEmbeddedDocuments('Token', updates, { teleport: true })
    const noteIds = canvas.scene.notes.map((n) => n.id)
    if (noteIds.length > 1) await canvas.scene.deleteEmbeddedDocuments('Note', noteIds.slice(1))
  })

  // Dump every scene: view (not activate — no need to change the world's active scene)
  // each one so the plugin's builders read it as canvas.scene, slice OFF for the full
  // multi-level payload. Level display names ride alongside (ViewerLevel carries no
  // name — the picker wants "Ground"/"Upper", not raw elevations).
  const sceneIds = await page.evaluate(() => game.scenes.map((s) => ({ id: s.id, name: s.name })))
  const scenes = []
  for (const meta of sceneIds) {
    const dump = await page.evaluate(async (sceneId) => {
      const s = game.scenes.get(sceneId)
      if (!s) return null
      if (canvas.scene?.id !== sceneId) {
        await s.view()
        await new Promise((r) => setTimeout(r, 300))
      }
      await window.CFGCore.overlay3D.setVisible(true)
      await new Promise((r) => setTimeout(r, 400))
      window.CFGCore.overlay3D.setSlice(false)
      await new Promise((r) => setTimeout(r, 600))

      const inst = window.CFGCore.overlay3D._instance
      const rect = inst._sceneRect()
      const { ambient, lights } = inst._buildLightsJson()
      const tokens = []
      for (const doc of canvas.scene.tokens) {
        const t = inst._tokenJson(doc)
        if (t) tokens.push(t)
      }
      const pxPerUnit = inst._pxPerUnit()
      const levelNames = (canvas.scene.levels?.contents ?? []).map((l) => ({
        name: l.name || null,
        elevation: inst._levelBase(l) * pxPerUnit,
      }))
      return {
        levelNames,
        json: {
          bounds: { width: rect.width, height: rect.height, x: rect.x, y: rect.y },
          background: { color: inst._sceneBackgroundColor() },
          grid: inst._buildGridJson(),
          levels: inst._buildLevelsJson(),
          ambient,
          lights,
          tokens,
          walls: inst._buildWallsJson(),
          tiles: inst._buildTilesJson(),
          notes: inst._buildNotesJson(),
        },
      }
    }, meta.id)
    if (dump) scenes.push({ id: meta.id, name: meta.name, ...dump })
  }
  // Leave the test scene in view for the other harness tools.
  await page.evaluate(async () => {
    const s = game.scenes.find((x) => x.name === 'CFG 3D Test')
    if (s && canvas.scene?.id !== s.id) await s.view()
  })

  // Rewrite Foundry-server asset URLs for the web host: our own fixtures map to copies
  // under public/img/dev-vtt-viewer/. Foundry's core icons aren't copied — but the two
  // this scene uses are themselves game-icons.net CC BY 3.0 icons, so they map to
  // copies fetched from the original source (see ATTRIBUTION.txt beside the assets):
  // mystery-man.svg ⇒ "Cowled" (Lorc), book.svg ⇒ "Book cover" (Delapouite). Any other
  // Foundry-served asset drops to null (color-box / plain-sprite fallback).
  const rewrite = (u) => {
    if (typeof u !== 'string') return u ?? null
    const m = u.match(/\/modules\/crit-fumble-core\/tests\/fixtures\/(.+)$/)
    if (m) return `/img/dev-vtt-viewer/${m[1]}`
    if (/\/icons\/svg\/mystery-man\.svg$/.test(u)) return '/img/dev-vtt-viewer/cowled.svg'
    if (/\/icons\/svg\/book\.svg$/.test(u)) return '/img/dev-vtt-viewer/book-cover.svg'
    return null
  }
  for (const sc of scenes) {
    for (const lv of sc.json.levels) lv.src = rewrite(lv.src)
    for (const t of sc.json.tokens) {
      t.texture = rewrite(t.texture)
      t.model = rewrite(t.model)
    }
    for (const n of sc.json.notes) n.texture = rewrite(n.texture)
  }

  writeFileSync(OUT, JSON.stringify(scenes, null, 2) + '\n')
  console.log('WROTE', OUT, '—', scenes.map((s) => `${s.name} (${s.json.levels.length} levels)`).join(', '))
} finally {
  await browser.close()
}
