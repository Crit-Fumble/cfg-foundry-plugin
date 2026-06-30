/**
 * verify-3d.mjs — standalone manual verification for the 3D overlay draft.
 *
 * Drives the running local Foundry (npm run test:foundry:up first), logs in as
 * GM, creates+activates a test scene with tokens at different elevations,
 * toggles the 3D overlay, and screenshots the result.
 *
 *   node tests/integration/verify-3d.mjs            # headless (SwiftShader GL)
 *   HEADED=1 node tests/integration/verify-3d.mjs   # headed (system GPU)
 *
 * Screenshots land in tests/test-results/. Not part of the Playwright suite —
 * this is a dev verification harness for the overnight build loop.
 */
import { chromium } from '@playwright/test'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { ensureInGame } from './shared/foundry-login.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = join(__dirname, '../test-results')
const URL = process.env.FOUNDRY_URL || 'http://localhost:30000'
const HEADED = process.env.HEADED === '1'

const launchArgs = HEADED
  ? []
  : ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--enable-webgl']

function log(...a) {
  console.log('[verify-3d]', ...a)
}

const browser = await chromium.launch({ headless: !HEADED, args: launchArgs })
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, baseURL: URL })
const page = await ctx.newPage()

const pageErrors = []
page.on('console', (m) => {
  const t = m.type()
  if (t === 'error' || t === 'warning') {
    const txt = m.text()
    if (/CFG Core|Overlay3D|three|WebGL|cfg-3d/i.test(txt)) pageErrors.push(`[${t}] ${txt}`)
  }
})
page.on('pageerror', (e) => pageErrors.push(`[pageerror] ${e.message}`))

try {
  log('logging in as GM at', URL)
  await ensureInGame(page)
  log('in game; CFGCore present:', await page.evaluate(() => !!window.CFGCore))

  // 1. Create + activate a test scene.
  log('creating/activating test scene')
  await page.evaluate(async () => {
    let scene = game.scenes.find((s) => s.name === 'CFG 3D Test')
    if (!scene) {
      scene = await Scene.create({
        name: 'CFG 3D Test',
        width: 2000,
        height: 2000,
        padding: 0.25,
        backgroundColor: '#222a33',
        grid: { type: 1, size: 100, distance: 5, units: 'ft' },
      })
    }
    if (!scene.active) await scene.activate()
  })
  await page.waitForFunction(() => globalThis.canvas?.ready === true, { timeout: 60_000 })

  // 2. Place tokens at different elevations + dispositions.
  log('placing tokens')
  await page.evaluate(async () => {
    const ids = canvas.scene.tokens.map((t) => t.id)
    if (ids.length) await canvas.scene.deleteEmbeddedDocuments('Token', ids)
    let actor = game.actors.find((a) => a.name === 'CFG Dummy')
    if (!actor) actor = await Actor.create({ name: 'CFG Dummy', type: 'character' })
    const src = 'icons/svg/mystery-man.svg'
    await canvas.scene.createEmbeddedDocuments('Token', [
      { name: 'Ground (friendly)', x: 500, y: 800, elevation: 0, width: 1, height: 1, texture: { src }, disposition: 1, actorId: actor.id },
      { name: 'Flyer (hostile, +20ft)', x: 950, y: 800, elevation: 20, width: 1, height: 1, texture: { src }, disposition: -1, actorId: actor.id },
      { name: 'Giant (neutral, 2x2)', x: 1350, y: 1000, elevation: 0, width: 2, height: 2, texture: { src }, disposition: 0, actorId: actor.id },
    ])
  })
  await page.waitForFunction(() => canvas.tokens.placeables.length >= 3, { timeout: 15_000 })

  // Walls — two default-height, one taller via the Wall Height convention.
  log('placing walls')
  await page.evaluate(async () => {
    const wids = canvas.scene.walls.map((w) => w.id)
    if (wids.length) await canvas.scene.deleteEmbeddedDocuments('Wall', wids)
    await canvas.scene.createEmbeddedDocuments('Wall', [
      { c: [400, 600, 1600, 600] },
      { c: [400, 600, 400, 1400] },
      { c: [1600, 600, 1600, 1400], flags: { 'wall-height': { bottom: 0, top: 30 } } },
    ])
  })
  await page.waitForFunction(() => canvas.walls.placeables.length >= 3, { timeout: 10_000 })

  await page.screenshot({ path: join(OUT, '3d-00-foundry-2d.png') })
  log('captured 2D baseline')

  // 3. Toggle the 3D overlay on.
  log('toggling 3D overlay on')
  const hasApi = await page.evaluate(() => !!window.CFGCore?.overlay3D)
  if (!hasApi) throw new Error('window.CFGCore.overlay3D is not exposed — service did not start')
  await page.evaluate(async () => {
    await window.CFGCore.overlay3D.setVisible(true)
  })
  await page.waitForFunction(() => window.CFGCore?.overlay3D?.isReady?.() === true, { timeout: 30_000 })
  await page.waitForTimeout(2000) // textures + orbit settle

  const info = await page.evaluate(() => {
    const c = document.querySelector('#cfg-3d-overlay canvas')
    return {
      ready: window.CFGCore.overlay3D.isReady(),
      visible: window.CFGCore.overlay3D.isVisible(),
      tokenCount: window.CFGCore.overlay3D.tokenCount(),
      hasCanvas: !!c,
      canvasSize: c ? [c.width, c.height] : null,
    }
  })
  log('OVERLAY INFO', JSON.stringify(info))

  await page.screenshot({ path: join(OUT, '3d-01-overlay-on.png') })
  log('captured 3D overlay screenshot')

  // 4. Move a token and confirm live sync (incremental updateToken path).
  log('moving a token to test live sync')
  const moveInfo = await page.evaluate(async () => {
    const t = canvas.tokens.placeables.find((x) => x.name?.startsWith('Flyer'))
    const inst = window.CFGCore.overlay3D._instance
    const before = t ? { x: t.document.x, y: t.document.y, e: t.document.elevation } : null
    const gBefore = t && inst._tokens.get(t.id) ? { ...inst._tokens.get(t.id).position } : null
    if (t) await t.document.update({ x: 1200, y: 500, elevation: 40 }, { teleport: true })
    const after = t ? { x: t.document.x, y: t.document.y, e: t.document.elevation } : null
    // give the hook a tick
    await new Promise((r) => setTimeout(r, 400))
    const gAfter = t && inst._tokens.get(t.id) ? { ...inst._tokens.get(t.id).position } : null
    return { before, after, gBefore, gAfter, pxPerUnit: inst._pxPerUnit() }
  })
  log('MOVE INFO', JSON.stringify(moveInfo))
  await page.waitForTimeout(1600)
  await page.screenshot({ path: join(OUT, '3d-02-after-move.png') })
  log('captured post-move screenshot')

  // 5. Confirm the Token-controls toggle is registered (the AM entry point),
  //    then toggle OFF and confirm the overlay hides.
  const toggleTool = await page.evaluate(() => {
    const controls = ui.controls?.controls
    if (!controls) return null
    const groups = Array.isArray(controls) ? controls : Object.values(controls)
    for (const g of groups) {
      const tools = g?.tools ? (Array.isArray(g.tools) ? g.tools : Object.values(g.tools)) : []
      const t = tools.find((x) => x?.name === 'cfg-3d-overlay')
      if (t) return { group: g.name, tool: t.name, toggle: t.toggle }
    }
    return null
  })
  log('TOGGLE TOOL', JSON.stringify(toggleTool))

  await page.evaluate(async () => {
    await window.CFGCore.overlay3D.setVisible(false)
  })
  await page.waitForTimeout(300)
  const offState = await page.evaluate(() => ({
    visible: window.CFGCore.overlay3D.isVisible(),
    display: document.querySelector('#cfg-3d-overlay')?.style.display,
  }))
  log('AFTER TOGGLE OFF', JSON.stringify(offState))

  log('PAGE WARNINGS/ERRORS:', pageErrors.length ? '\n  ' + pageErrors.join('\n  ') : 'none')
  log('DONE ok')
} catch (err) {
  log('FAILED:', err?.message || err)
  log('PAGE WARNINGS/ERRORS:', pageErrors.length ? '\n  ' + pageErrors.join('\n  ') : 'none')
  try {
    await page.screenshot({ path: join(OUT, '3d-99-failure.png') })
  } catch {
    /* ignore */
  }
  process.exitCode = 1
} finally {
  await browser.close()
}
