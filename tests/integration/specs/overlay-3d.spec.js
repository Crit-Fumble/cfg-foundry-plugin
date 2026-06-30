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
// Native v14 Level background maps — relative FilePathField-valid paths served
// from the module's fixtures dir (the overlay resolves them to absolute URLs).
const LEVEL_GROUND_SRC = 'modules/crit-fumble-core/tests/fixtures/level-ground.png'
const LEVEL_UPPER_SRC = 'modules/crit-fumble-core/tests/fixtures/level-upper.png'

/** Hide Foundry's notification toasts (incl. the headless "no GPU" banner) for clean shots. */
async function hideChrome(page) {
  await page.evaluate(() => {
    const n = document.getElementById('notifications')
    if (n) n.style.display = 'none'
  })
}

test('3D overlay — seed a scene and capture review angles', async ({ page }) => {
  test.setTimeout(120_000) // scene setup + lighting + two camera modes + 6 captures
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error' && /Overlay3D|cfg-3d|three/i.test(m.text())) errors.push(m.text())
  })

  await ensureInGame(page)
  await expect.poll(() => page.evaluate(() => !!window.CFGCore?.overlay3D), { timeout: 30_000 }).toBe(true)
  await page.evaluate(() => {
    if (game.paused) game.togglePause(false)
  })

  // Activate a clean test scene.
  await page.evaluate(async () => {
    let scene = game.scenes.find((s) => s.name === 'CFG 3D Test')
    if (!scene) {
      scene = await Scene.create({
        name: 'CFG 3D Test',
        width: 2000,
        height: 2000,
        padding: 0.25,
        backgroundColor: '#4f7a46',
        grid: { type: 1, size: 100, distance: 5, units: 'ft' },
      })
    }
    if (!scene.active) await scene.activate()
  })
  await page.waitForFunction(() => globalThis.canvas?.ready === true, { timeout: 60_000 })

  // Tokens (incl. a GLB-model token) + walls (incl. a Wall-Height tall one).
  await page.evaluate(async ({ MODEL_URL, LEVEL_GROUND_SRC, LEVEL_UPPER_SRC }) => {
    const tIds = canvas.scene.tokens.map((t) => t.id)
    if (tIds.length) await canvas.scene.deleteEmbeddedDocuments('Token', tIds)
    const wIds = canvas.scene.walls.map((w) => w.id)
    if (wIds.length) await canvas.scene.deleteEmbeddedDocuments('Wall', wIds)

    // Native v14 Levels FIRST so tokens can be assigned to a floor by id. In v14
    // the scene's base map IS the first Level: make it the Ground floor (opaque
    // map, elev 0-20), then add an Upper floor (elev 20-40) whose map is
    // transparent in the centre — so in 3D the ground shows through the hole.
    // Idempotent: update-or-create so re-runs reset elevations.
    const groundLvl = canvas.scene.levels.contents[0]
    if (groundLvl) {
      await groundLvl.update({ name: 'Ground', 'elevation.bottom': 0, 'elevation.top': 20, 'background.src': LEVEL_GROUND_SRC, sort: 0 })
    } else {
      await canvas.scene.createEmbeddedDocuments('Level', [{ name: 'Ground', elevation: { bottom: 0, top: 20 }, background: { src: LEVEL_GROUND_SRC }, sort: 0 }])
    }
    const upperLvl = canvas.scene.levels.contents.find((l) => l.name === 'Upper')
    if (upperLvl) {
      await upperLvl.update({ 'elevation.bottom': 20, 'elevation.top': 40, 'background.src': LEVEL_UPPER_SRC, sort: 10 })
    } else {
      await canvas.scene.createEmbeddedDocuments('Level', [{ name: 'Upper', elevation: { bottom: 20, top: 40 }, background: { src: LEVEL_UPPER_SRC }, sort: 10 }])
    }
    const groundId = canvas.scene.levels.contents[0].id
    const upperId = (canvas.scene.levels.contents.find((l) => l.name === 'Upper') || {}).id || groundId

    const actor = game.actors.find((a) => a.name === 'CFG Dummy') ?? (await Actor.create({ name: 'CFG Dummy', type: 'character' }))
    const src = 'icons/svg/mystery-man.svg'
    await canvas.scene.createEmbeddedDocuments('Token', [
      // Resting on the Ground floor (base == elevation → no post): friendly w/ light, a giant, a GLB tree.
      { name: 'Center (friendly)', x: 1450, y: 1450, level: groundId, elevation: 0, width: 1, height: 1, texture: { src }, disposition: 1, actorId: actor.id, light: { dim: 26, bright: 13, color: '#ffce8a', luminosity: 0.4, alpha: 0.5 } },
      { name: 'Giant (neutral, 2x2)', x: 1650, y: 1600, level: groundId, elevation: 0, width: 2, height: 2, texture: { src }, disposition: 0, actorId: actor.id },
      { name: 'Tree (GLB model)', x: 1150, y: 1650, level: groundId, elevation: 0, width: 2, height: 2, texture: { src }, disposition: 0, actorId: actor.id, flags: { 'crit-fumble-core': { modelSrc: MODEL_URL } } },
      // FLYING over the Ground floor (elev 15 over base 0) → flight-stand post + "+15 ft" label.
      { name: 'Flier (Ground +15ft)', x: 1300, y: 1550, level: groundId, elevation: 15, width: 1, height: 1, texture: { src }, disposition: -1, actorId: actor.id },
      // FLYING over the UPPER floor (elev 30 over base 20) → its post is anchored to the upper floor, not the ground.
      { name: 'Upstairs flier (+30ft)', x: 1500, y: 1300, level: upperId, elevation: 30, width: 1, height: 1, texture: { src }, disposition: -1, actorId: actor.id },
    ])
    // A centered room with corners on the scene grid, fully inside the scene
    // rect (no padding overhang) — makes wall/token alignment obvious.
    await canvas.scene.createEmbeddedDocuments('Wall', [
      { c: [1000, 1000, 2000, 1000] },
      { c: [1000, 2000, 2000, 2000] },
      { c: [1000, 1000, 1000, 2000] },
      { c: [2000, 1000, 2000, 2000], flags: { 'wall-height': { bottom: 0, top: 30 } } },
    ])
    // Tiles as floor surfaces at their elevation: a ground rug (elev 0, in a
    // corner so it doesn't cover the hole) + a platform on the upper floor
    // (elev 20) under the upstairs flier.
    const oldTiles = canvas.scene.tiles.map((t) => t.id)
    if (oldTiles.length) await canvas.scene.deleteEmbeddedDocuments('Tile', oldTiles)
    await canvas.scene.createEmbeddedDocuments('Tile', [
      { x: 1100, y: 1600, width: 320, height: 320, elevation: 0 },
      { x: 1380, y: 1180, width: 360, height: 360, elevation: 20 },
    ])
    // A map note pin — UI on the map, rendered as a flat marker (not 3D geometry).
    await canvas.scene.createEmbeddedDocuments('Note', [
      { x: 1750, y: 1300, text: 'Quest', texture: { src: 'icons/svg/book.svg' }, iconSize: 60, fontSize: 28, global: true },
    ])
    // A warm ambient light + some darkness, to show the 3D uses the scene's lighting.
    const lids = canvas.scene.lights.map((l) => l.id)
    if (lids.length) await canvas.scene.deleteEmbeddedDocuments('AmbientLight', lids)
    await canvas.scene.createEmbeddedDocuments('AmbientLight', [
      { x: 1500, y: 1350, config: { color: '#ff8a3d', dim: 28, bright: 14, alpha: 0.6, luminosity: 0.5 } },
    ])
    await canvas.scene.update({ 'environment.darknessLevel': 0.25 }).catch(() => {})
  }, { MODEL_URL, LEVEL_GROUND_SRC, LEVEL_UPPER_SRC })
  await page.waitForFunction(
    () =>
      canvas.scene.tokens.size >= 5 &&
      canvas.walls.placeables.length >= 3 &&
      canvas.tiles.placeables.length >= 2 &&
      canvas.scene.levels.contents.filter((l) => l.background?.src).length >= 2 &&
      canvas.notes.placeables.length >= 1 &&
      canvas.lighting.placeables.length >= 1,
    { timeout: 15_000 },
  )

  // Baseline: the normal Foundry 2D canvas.
  await hideChrome(page)
  await page.screenshot({ path: join(SHOTS, '01-foundry-2d.png') })

  // Toggle the 3D overlay on.
  await page.evaluate(() => window.CFGCore.overlay3D.setVisible(true))
  await expect.poll(() => page.evaluate(() => window.CFGCore.overlay3D.isReady()), { timeout: 30_000 }).toBe(true)
  // Start unsliced so the build assertions see every floor's tokens; the slice
  // cutaway (on by default) is exercised explicitly later.
  await page.evaluate(() => window.CFGCore.overlay3D.setSlice(false))
  await page.waitForTimeout(3000) // textures + GLB model load

  // Assertions on what got built.
  const info = await page.evaluate(() => ({
    ready: window.CFGCore.overlay3D.isReady(),
    tokens: window.CFGCore.overlay3D.tokenCount(),
    hasCanvas: !!document.querySelector('#cfg-3d-overlay canvas'),
    // A dedicated top-level "3D View" control group (not a tool under Tokens),
    // with its nested tools (enable toggle, mode, slice, camera presets).
    group: (() => {
      const c = ui.controls?.controls
      const groups = c ? (Array.isArray(c) ? c : Object.values(c)) : []
      const g = groups.find((x) => x?.name === 'cfg-3d')
      if (!g) return null
      const tools = g.tools ? (Array.isArray(g.tools) ? g.tools : Object.values(g.tools)) : []
      return { title: g.title, tools: tools.map((t) => t.name) }
    })(),
  }))
  expect(info.ready).toBe(true)
  expect(info.tokens).toBe(5)
  expect(info.hasCanvas).toBe(true)
  expect(info.group, 'top-level 3D control group should exist').not.toBeNull()
  expect(info.group.tools).toEqual(expect.arrayContaining(['toggle', 'mode', 'slice', 'viewTop', 'viewReset']))

  // --- Tracked (top-down) mode — the camera mirrors Foundry, so canvas-anchored
  //     UI lines up over the 3D. Pan Foundry to frame the room + select a token
  //     so its HUD shows, then prove the projection matches Foundry's. ---
  expect(await page.evaluate(() => window.CFGCore.overlay3D.getMode())).toBe('tracked')
  await page.evaluate(async () => {
    await canvas.pan({ x: 1500, y: 1500, scale: 0.42 })
    const t = canvas.tokens.placeables.find((x) => x.name?.startsWith('Center')) || canvas.tokens.placeables[0]
    t?.control({ releaseOthers: true })
  })
  await page.waitForTimeout(900)

  const align = await page.evaluate(() => {
    const inst = window.CFGCore.overlay3D._instance
    const t = canvas.tokens.controlled[0] || canvas.tokens.placeables[0]
    const c = t.center
    const f = canvas.clientCoordinatesFromCanvas({ x: c.x, y: c.y }) // Foundry screen px
    const THREE = inst._THREE
    const v = new THREE.Vector3(c.x, 0, c.y).project(inst._trackedCamera) // tracked-cam projection
    const sx = ((v.x + 1) / 2) * window.innerWidth
    const sy = ((1 - v.y) / 2) * window.innerHeight
    return { foundry: [Math.round(f.x), Math.round(f.y)], three: [Math.round(sx), Math.round(sy)], dx: Math.round(sx - f.x), dy: Math.round(sy - f.y) }
  })
  console.log('[overlay-3d] tracked projection vs Foundry:', JSON.stringify(align))
  expect(Math.abs(align.dx), `x off by ${align.dx}px`).toBeLessThan(3)
  expect(Math.abs(align.dy), `y off by ${align.dy}px`).toBeLessThan(3)

  await hideChrome(page) // hides the notification banner; the Token HUD stays (it aligns)
  await page.screenshot({ path: join(SHOTS, '02-tracked.png') })

  // --- Orbit (free-look) mode. ---
  await page.evaluate(() => window.CFGCore.overlay3D.setMode('orbit'))
  await page.waitForTimeout(400)

  // Slice OFF → the full multi-floor "dollhouse" (both level maps render) for the
  // review angles.
  await page.evaluate(() => window.CFGCore.overlay3D.setSlice(false))
  await page.waitForTimeout(400)
  const levelBgCount = await page.evaluate(() => window.CFGCore.overlay3D._instance._levelBackgrounds.length)
  console.log('[overlay-3d] native Level background planes (slice off):', levelBgCount)
  expect(levelBgCount, 'Ground + Upper level maps both render with slice off').toBeGreaterThanOrEqual(2)

  const views = [
    ['03-orbit-default', 'default'],
    ['04-orbit-top', 'top'],
    ['05-orbit-angle', 'angle'],
    ['06-orbit-low', 'low'],
  ]
  for (const [name, preset] of views) {
    await page.evaluate((p) => window.CFGCore.overlay3D.setView(p), preset)
    await hideChrome(page)
    await page.waitForTimeout(700)
    await page.screenshot({ path: join(SHOTS, `${name}.png`) })
  }

  // --- Floor slice (cutaway) — focus a ground-floor token; the Upper floor (its
  //     map + the upstairs flier) is hidden so it can't block the view, leaving
  //     just the Ground floor and anything below it (TaleSpire-style). ---
  await page.evaluate(async () => {
    // Opt into focus-follow (off by default) so selecting a token slices to its floor.
    await game.settings.set('crit-fumble-core', 'overlay3dFocusFollow', true)
    window.CFGCore.overlay3D.setSlice(true)
    const t = canvas.tokens.placeables.find((x) => x.name?.startsWith('Center')) || canvas.tokens.placeables[0]
    t?.control({ releaseOthers: true })
  })
  await page.waitForTimeout(700) // controlToken → debounced rebuild
  const sliced = await page.evaluate(() => ({
    bg: window.CFGCore.overlay3D._instance._levelBackgrounds.length,
    tokens: window.CFGCore.overlay3D.tokenCount(),
    active: window.CFGCore.overlay3D.getActiveLevel(),
  }))
  console.log('[overlay-3d] floor-slice (focus ground floor):', JSON.stringify(sliced))
  expect(sliced.bg, 'slice hides the Upper floor map').toBe(1)
  expect(sliced.tokens, 'slice hides the upstairs flier on the upper floor').toBe(4)
  await page.evaluate((p) => window.CFGCore.overlay3D.setView(p), 'angle')
  await hideChrome(page)
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(SHOTS, '07-slice-ground.png') })

  if (errors.length) console.warn('[overlay-3d] non-fatal page errors:\n  ' + errors.join('\n  '))
})
