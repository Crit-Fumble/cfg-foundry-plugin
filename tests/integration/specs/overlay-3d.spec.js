/**
 * 3D overlay — screenshot review spec.
 *
 * Seeds a scene (background, tokens at different elevations + dispositions,
 * walls incl. a Wall-Height-flagged tall one, a GLB-model token) and captures
 * the 3D view from several camera angles for visual review. Also asserts the
 * overlay mounts, the toggle is registered, and the expected objects are built.
 *
 * Run just this:  npm run test:foundry:3d   (needs `npm run test:foundry:up`)
 * Screenshots →   tests/test-results/3d/*.png
 */
import { test, expect } from '@playwright/test'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { ensureInGame } from '../shared/foundry-login.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(__dirname, '../../test-results/3d')
const MODEL_URL = 'http://localhost:30000/modules/crit-fumble-core/tests/fixtures/sample-tree.glb'

/** Hide Foundry's notification toasts (incl. the headless "no GPU" banner) for clean shots. */
async function hideChrome(page) {
  await page.evaluate(() => {
    const n = document.getElementById('notifications')
    if (n) n.style.display = 'none'
  })
}

test('3D overlay — seed a scene and capture review angles', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error' && /Overlay3D|cfg-3d|three/i.test(m.text())) errors.push(m.text())
  })

  await ensureInGame(page)
  await expect.poll(() => page.evaluate(() => !!window.CFGCore?.overlay3D), { timeout: 30_000 }).toBe(true)

  // Activate a clean test scene.
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

  // Tokens (incl. a GLB-model token) + walls (incl. a Wall-Height tall one).
  await page.evaluate(async (MODEL_URL) => {
    const tIds = canvas.scene.tokens.map((t) => t.id)
    if (tIds.length) await canvas.scene.deleteEmbeddedDocuments('Token', tIds)
    const wIds = canvas.scene.walls.map((w) => w.id)
    if (wIds.length) await canvas.scene.deleteEmbeddedDocuments('Wall', wIds)
    const actor = game.actors.find((a) => a.name === 'CFG Dummy') ?? (await Actor.create({ name: 'CFG Dummy', type: 'character' }))
    const src = 'icons/svg/mystery-man.svg'
    await canvas.scene.createEmbeddedDocuments('Token', [
      { name: 'Ground (friendly)', x: 500, y: 800, elevation: 0, width: 1, height: 1, texture: { src }, disposition: 1, actorId: actor.id },
      { name: 'Flyer (hostile, +20ft)', x: 950, y: 800, elevation: 20, width: 1, height: 1, texture: { src }, disposition: -1, actorId: actor.id },
      { name: 'Giant (neutral, 2x2)', x: 1350, y: 1000, elevation: 0, width: 2, height: 2, texture: { src }, disposition: 0, actorId: actor.id },
      { name: 'Tree (GLB model)', x: 650, y: 1150, elevation: 0, width: 2, height: 2, texture: { src }, disposition: 0, actorId: actor.id, flags: { 'crit-fumble-core': { modelSrc: MODEL_URL } } },
    ])
    await canvas.scene.createEmbeddedDocuments('Wall', [
      { c: [400, 600, 1600, 600] },
      { c: [400, 600, 400, 1400] },
      { c: [1600, 600, 1600, 1400], flags: { 'wall-height': { bottom: 0, top: 30 } } },
    ])
  }, MODEL_URL)
  await page.waitForFunction(() => canvas.tokens.placeables.length >= 4 && canvas.walls.placeables.length >= 3, { timeout: 15_000 })

  // Baseline: the normal Foundry 2D canvas.
  await hideChrome(page)
  await page.screenshot({ path: join(SHOTS, '01-foundry-2d.png') })

  // Toggle the 3D overlay on.
  await page.evaluate(() => window.CFGCore.overlay3D.setVisible(true))
  await expect.poll(() => page.evaluate(() => window.CFGCore.overlay3D.isReady()), { timeout: 30_000 }).toBe(true)
  await page.waitForTimeout(3000) // textures + GLB model load

  // Assertions on what got built.
  const info = await page.evaluate(() => ({
    ready: window.CFGCore.overlay3D.isReady(),
    tokens: window.CFGCore.overlay3D.tokenCount(),
    hasCanvas: !!document.querySelector('#cfg-3d-overlay canvas'),
    toggle: (() => {
      const c = ui.controls?.controls
      const groups = c ? (Array.isArray(c) ? c : Object.values(c)) : []
      return groups.some((g) => {
        const tools = g?.tools ? (Array.isArray(g.tools) ? g.tools : Object.values(g.tools)) : []
        return tools.some((t) => t?.name === 'cfg-3d-overlay')
      })
    })(),
  }))
  expect(info.ready).toBe(true)
  expect(info.tokens).toBe(4)
  expect(info.hasCanvas).toBe(true)
  expect(info.toggle).toBe(true)

  // Capture the 3D view from several review angles.
  const views = [
    ['02-3d-default', 'default'],
    ['03-3d-top', 'top'],
    ['04-3d-angle', 'angle'],
    ['05-3d-low', 'low'],
  ]
  for (const [name, preset] of views) {
    await page.evaluate((p) => window.CFGCore.overlay3D.setView(p), preset)
    await hideChrome(page)
    await page.waitForTimeout(700)
    await page.screenshot({ path: join(SHOTS, `${name}.png`) })
  }

  if (errors.length) console.warn('[overlay-3d] non-fatal page errors:\n  ' + errors.join('\n  '))
})
