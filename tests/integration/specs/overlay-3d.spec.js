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
      // BELOW the Ground floor (elev -15 under base 0) → post attaches at the mini's TOP,
      // not its feet, so it reads as hanging from the surface rather than piercing through.
      { name: 'Burrower (Ground -15ft)', x: 1600, y: 1450, level: groundId, elevation: -15, width: 1, height: 1, texture: { src }, disposition: 0, actorId: actor.id },
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
    const oldNotes = canvas.scene.notes.map((n) => n.id)
    if (oldNotes.length) await canvas.scene.deleteEmbeddedDocuments('Note', oldNotes)
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
  expect(info.tokens, 'every 3D mode renders its own opaque token minis').toBe(6)
  expect(info.hasCanvas).toBe(true)
  expect(info.group, 'top-level 3D control group should exist').not.toBeNull()
  // The toolbar keeps ONE 3D on/off toggle (+ slice and the terrain ACTIONS). The camera MODES
  // moved to the shared CameraModeSwitcher above the hotbar, and the sculpt TOOLS to the shared
  // React rail hosted in this same tool column — so players and GMs pick views in one place.
  expect(info.group.tools).toEqual(expect.arrayContaining(['view3d', 'slice']))
  expect(info.group.tools, 'camera modes are no longer toolbar buttons').not.toEqual(expect.arrayContaining(['topdown', 'free', 'firstperson']))
  expect(info.group.tools, 'sculpt tools moved to the shared React rail').not.toEqual(expect.arrayContaining(['sculptRaise', 'sculptLower']))
  expect(info.group.tools, 'per-angle camera preset buttons removed').not.toEqual(expect.arrayContaining(['viewTop', 'viewAngle', 'viewLow', 'viewReset']))

  // Underground token (elevation -15 under its floor base 0): the flight-stand post's
  // LOWER edge should sit at the mini's TOP (≈ its footprint, one grid square here), not
  // at its feet (local y = 0) — hanging from the surface, not piercing through the mini.
  const burrower = await page.evaluate(() => {
    const inst = window.CFGCore.overlay3D._instance
    const doc = canvas.scene.tokens.find((t) => t.name?.startsWith('Burrower'))
    const g = inst._viewer.tokens.get(doc.id)
    const stalk = g?.children.find((c) => c.geometry?.type === 'CylinderGeometry')
    // Stalks use the core's POOLED unit cylinder scaled per-token: visual height = parameters.height × scale.y.
    const lowerY = stalk ? stalk.position.y - (stalk.geometry.parameters.height * stalk.scale.y) / 2 : null
    return { lowerY, footprint: canvas.dimensions.size }
  })
  console.log('[overlay-3d] burrower stalk:', JSON.stringify(burrower))
  expect(burrower.lowerY, 'no stalk found on the underground token').not.toBeNull()
  expect(Math.abs(burrower.lowerY - burrower.footprint), `post's lower edge ${burrower.lowerY} should be at the mini's top (footprint ${burrower.footprint}), not its feet (0)`).toBeLessThan(1)

  // --- Top Down — a TRUE top-down 3D: opaque, camera directly overhead looking
  //     straight down (not angled), arrow-pan + wheel-zoom + 3D-pick select/target. ---
  expect(await page.evaluate(() => window.CFGCore.overlay3D.getMode())).toBe('tracked')
  await page.waitForTimeout(400)
  const td = await page.evaluate(() => {
    const inst = window.CFGCore.overlay3D._instance
    inst._syncTrackedCamera()
    const cam = inst._orbitCamera
    const focusBefore = { ...inst._trackFocus }
    // `code` is REQUIRED: Foundry keybindings (and the overlay's _controlMap) are code-keyed, so a
    // synthetic event carrying only `key` matches nothing a real keyboard would send.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }))
    return {
      opaque: inst._foundryFloor() === false,
      pe: getComputedStyle(document.getElementById('cfg-3d-overlay')).pointerEvents,
      // Offsets vs the CURRENT focus — the ArrowRight handler above re-syncs the
      // camera to the panned focus synchronously, so the pre-pan snapshot is stale.
      camY: Math.round(cam.position.y),
      camXoff: Math.round(cam.position.x - inst._trackFocus.x), // true top-down → directly overhead
      camZoff: Math.round(cam.position.z - inst._trackFocus.z),
      upIsHorizontal: Math.abs(cam.up.y) < 0.01, // straight-down view needs a horizontal up axis
      pannedX: inst._trackFocus.x - focusBefore.x,
    }
  })
  console.log('[overlay-3d] top-down:', JSON.stringify(td))
  expect(td.opaque, 'top-down is opaque (own 3D scene — no Foundry-2D show-through to duplicate)').toBe(true)
  expect(td.pe, 'top-down captures the mouse for 3D picking').toBe('auto')
  expect(td.camY, 'camera is elevated above the board').toBeGreaterThan(100)
  expect(Math.abs(td.camXoff), 'camera is directly overhead (no X offset) — TRUE top-down, not angled').toBeLessThan(1)
  expect(Math.abs(td.camZoff), 'camera is directly overhead (no Z offset) — TRUE top-down, not angled').toBeLessThan(1)
  expect(td.upIsHorizontal, 'camera.up is a horizontal axis (screen-space rotation defined when looking straight down)').toBe(true)
  expect(td.pannedX, 'ArrowRight pans the camera focus').toBeGreaterThan(0)

  await hideChrome(page) // hides the notification banner; the Token HUD stays (it aligns)
  await page.screenshot({ path: join(SHOTS, '02-tracked.png') })

  // --- Orbit (free-look) mode. ---
  await page.evaluate(() => window.CFGCore.overlay3D.setMode('orbit'))
  await page.waitForTimeout(400)

  // Slice OFF → the full multi-floor "dollhouse" (both level maps render) for the
  // review angles.
  await page.evaluate(() => window.CFGCore.overlay3D.setSlice(false))
  await page.waitForTimeout(400)
  const levelBgCount = await page.evaluate(() => window.CFGCore.overlay3D._instance._viewer.getSceneGraph().levelCount)
  console.log('[overlay-3d] native Level background planes (slice off):', levelBgCount)
  expect(levelBgCount, 'Ground + Upper level maps both render with slice off').toBeGreaterThanOrEqual(2)

  // A Tile sits centered in its grid square exactly like a token. A Tile's (x,y) is
  // its (default-centered) texture anchor — already the tile CENTER — so the 3D mesh
  // world (x,z) must equal Foundry's own tile center, NOT center+half-size. Regression
  // guard for the half-size off-grid tile shift.
  const tileAlign = await page.evaluate(() => {
    const inst = window.CFGCore.overlay3D._instance
    const doc = canvas.scene.tiles.find((t) => t.x === 1100 && t.y === 1600)
    const placeable = canvas.tiles.get(doc.id)
    const mesh = inst._viewer.scene.children.find(
      (m) => m.geometry?.type === 'PlaneGeometry' && Math.abs((m.geometry?.parameters?.width ?? 0) - doc.width) < 1e-6 && Math.abs((m.geometry?.parameters?.height ?? 0) - doc.height) < 1e-6,
    )
    return { foundryCenter: [placeable.center.x, placeable.center.y], topLeft: [doc.x, doc.y], mesh: mesh ? [mesh.position.x, mesh.position.z] : null }
  })
  console.log('[overlay-3d] tile alignment (foundryCenter vs mesh):', JSON.stringify(tileAlign))
  expect(tileAlign.mesh, 'ground tile mesh exists in orbit mode').not.toBeNull()
  expect(Math.abs(tileAlign.mesh[0] - tileAlign.foundryCenter[0]), `tile world-x off by ${tileAlign.mesh[0] - tileAlign.foundryCenter[0]}`).toBeLessThan(0.5)
  expect(Math.abs(tileAlign.mesh[1] - tileAlign.foundryCenter[1]), `tile world-z off by ${tileAlign.mesh[1] - tileAlign.foundryCenter[1]}`).toBeLessThan(0.5)

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
    bg: window.CFGCore.overlay3D._instance._viewer.getSceneGraph().levelCount,
    tokens: window.CFGCore.overlay3D.tokenCount(),
    active: window.CFGCore.overlay3D.getActiveLevel(),
  }))
  console.log('[overlay-3d] floor-slice (focus ground floor):', JSON.stringify(sliced))
  expect(sliced.bg, 'slice hides the Upper floor map').toBe(1)
  expect(sliced.tokens, 'slice hides the upstairs flier on the upper floor').toBe(5)
  await page.evaluate((p) => window.CFGCore.overlay3D.setView(p), 'angle')
  await hideChrome(page)
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(SHOTS, '07-slice-ground.png') })

  if (errors.length) console.warn('[overlay-3d] non-fatal page errors:\n  ' + errors.join('\n  '))
})

test('3D controls — iterate the menu view modes + first-person WASD', async ({ page }) => {
  test.setTimeout(120_000)
  await ensureInGame(page)
  await expect.poll(() => page.evaluate(() => !!window.CFGCore?.overlay3D), { timeout: 30_000 }).toBe(true)
  await page.evaluate(async () => {
    const scene = game.scenes.find((s) => s.name === 'CFG 3D Test')
    if (scene && !scene.active) await scene.activate()
    if (game.paused) game.togglePause(false)
  })
  await page.waitForFunction(() => globalThis.canvas?.ready === true, { timeout: 60_000 })

  // Enter 3D from the toolbar toggle, then iterate modes by CLICKING the shared camera switcher
  // above the hotbar — the real UI path now that camera modes left the toolbar.
  await page.evaluate(async () => ui.controls.activate({ control: 'cfg-3d', toggles: { view3d: true } }))
  await page.waitForTimeout(900)
  await expect.poll(() => page.evaluate(() => !!document.querySelector('[data-testid="cfgr-camera-switcher"]')), { timeout: 15_000 }).toBe(true)

  const modes = ['topdown', 'tabletop', 'tabletop-gm', 'free', 'firstperson']
  const results = {}
  for (const mode of modes) {
    const testid = mode === 'firstperson' ? 'cfgr-camera-character' : `cfgr-camera-${mode}`
    await page.click(`[data-testid="${testid}"]`)
    await page.waitForTimeout(900)
    results[mode] = await page.evaluate(() => ({
      viewMode: window.CFGCore.overlay3D.getViewMode(),
      visible: window.CFGCore.overlay3D.isVisible(),
    }))
  }
  console.log('[overlay-3d] menu view modes:', JSON.stringify(results))
  expect(results.topdown.viewMode).toBe('topdown')
  expect(results.tabletop.viewMode, 'Party seat').toBe('tabletop')
  expect(results['tabletop-gm'].viewMode, "GM's side of the table").toBe('tabletop-gm')
  expect(results.free.viewMode).toBe('free')
  expect(results.firstperson.viewMode).toBe('firstperson')
  for (const m of modes) expect(results[m].visible, `${m} should make the overlay visible`).toBe(true)

  // 2D: pick "2D" in the switcher → overlay off (and the bar hides with it).
  await page.click('[data-testid="cfgr-camera-2d"]')
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => window.CFGCore.overlay3D.getViewMode())).toBe('2d')
  expect(await page.evaluate(() => window.CFGCore.overlay3D.isVisible())).toBe(false)

  // First-person: control a token (rotation 0 = facing south) to set the subject,
  // then switch to first-person. Switching control groups releases the canvas
  // selection, so the overlay follows the *last-controlled* token.
  const tokenId = await page.evaluate(async () => {
    canvas.tokens.activate() // token layer active so control() fires controlToken
    const t = canvas.tokens.placeables.find((x) => x.name?.startsWith('Center')) || canvas.tokens.placeables[0]
    await t.document.update({ rotation: 0 })
    t.control({ releaseOthers: true })
    await new Promise((r) => setTimeout(r, 150))
    // Camera modes moved out of the toolbar to the shared switcher; this block is about WASD, and
    // the switcher path for Character view is already covered above, so enter it via the API.
    await window.CFGCore.overlay3D.setViewMode('firstperson')
    return t.id
  })
  await page.waitForTimeout(1500)
  await hideChrome(page)
  await page.screenshot({ path: join(SHOTS, '08-first-person.png') })

  // --- First-person controls: WASD move (A/D strafe), mouse-look turns. ---
  const read = (id) =>
    page.evaluate((tid) => {
      const d = canvas.scene.tokens.get(tid)
      return { x: d.x, y: d.y, rotation: d.rotation }
    }, id)
  // `code` mirrors a real press (Foundry keybindings are code-keyed): 'w' → 'KeyW', 'ArrowUp' → itself.
  const codeFor = (k) => (/^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : k)
  const key = (k, type) =>
    page.evaluate(([kk, tt, cc]) => window.dispatchEvent(new KeyboardEvent(tt, { key: kk, code: cc, bubbles: true, cancelable: true })), [k, type, codeFor(k)])
  const tap = async (k) => {
    await key(k, 'keydown')
    await key(k, 'keyup')
  }
  const gridSize = await page.evaluate(() => canvas.dimensions.size)
  const reset = (tid) => page.evaluate(async (id) => canvas.scene.tokens.get(id).update({ x: 1450, y: 1450, rotation: 0 }, { teleport: true }), tid)

  // (a) WASD moves the token (camera-relative), one grid per press in grid mode;
  //     movement TURNS the token to face its direction of travel (Foundry-native 2D behaviour,
  //     opt-out per token via lockRotation) while the Character-View camera looks independently. No more {teleport:true}
  //     — Foundry's native "walk" movement action animates the sprite and shows its
  //     own measuring ruler during the move (same as the default 2D view), instead of
  //     an instant snap. Also: the 3D mini is driven directly from local camera state
  //     every frame (see _fpSyncSubjectVisual), not the ~90ms throttled document-
  //     commit hook — in grid-step mode _fpCenter itself jumps immediately on
  //     keydown, so this shrinks the mini's visible lag from ~90ms to ~1 frame
  //     rather than animating a gradual glide (that's fine-movement's job instead).
  await page.evaluate(() => game.settings.set('crit-fumble-core', 'overlay3dFineMovement', false))
  await reset(tokenId) // uses its own {teleport:true} for instant test setup — not the plugin's commit path
  await page.waitForTimeout(300)
  let b = await read(tokenId)
  // Only listen from here — reset()'s own teleport-based update would otherwise
  // also log the deprecation warning and produce a false failure below.
  const deprecationWarnings = []
  page.on('console', (m) => {
    if (m.type() === 'warning' && /teleport.*deprecated/i.test(m.text())) deprecationWarnings.push(m.text())
  })
  const startCenter = { x: b.x + gridSize / 2, y: b.y + gridSize / 2 } // token is 1×1 grid
  await key('w', 'keydown')
  await page.waitForTimeout(60) // early — well before Foundry's animation settles (~500ms for one grid step)
  const early = await page.evaluate(
    ({ id, sc }) => {
      const inst = window.CFGCore.overlay3D._instance
      const g = inst._viewer.tokens.get(id)
      // World (x, z) maps to Foundry (x, y) — WASD is camera-relative (Action-RPG),
      // so "W" isn't necessarily +x; measure total displacement from the start instead.
      const dist = g ? Math.hypot(g.position.x - sc.x, g.position.z - sc.y) : null
      return { miniDist: dist }
    },
    { id: tokenId, sc: startCenter },
  )
  // Foundry's own animation takes its own sweet time (~200-500ms for one grid step,
  // confirmed live) — `Token#showRuler` (a real getter, not the `_rulerPaths` PIXI
  // container, which Foundry redraws in place rather than adding/removing children)
  // only flips true partway in. Sample mid-window, well after our own instant local
  // state has already settled.
  await page.waitForTimeout(240)
  const midFlight = await page.evaluate((id) => {
    const t = canvas.tokens.get(id)
    return { showRuler: t?.showRuler ?? null }
  }, tokenId)
  await key('w', 'keyup')
  // Foundry's NATIVE walk animates, so the position + facing land asynchronously — poll until the
  // token has actually settled instead of racing a fixed sleep.
  await expect
    .poll(async () => { const r = await read(tokenId); return Math.round(Math.hypot(r.x - b.x, r.y - b.y)) }, { timeout: 5_000 })
    .toBeGreaterThan(gridSize * 0.1)
  await page.waitForTimeout(400) // let the trailing rotation commit flush
  let a = await read(tokenId)
  console.log('[overlay-3d] character move W:', JSON.stringify({ b, a, early, midFlight, deprecationWarnings: deprecationWarnings.length }))
  const mdx = a.x - b.x
  const mdy = a.y - b.y
  const moveHeading = (((Math.atan2(mdy, mdx) * 180) / Math.PI - 90) % 360 + 360) % 360
  // Movement is CONTINUOUS, matching Foundry's native 2D behaviour (the baseline) — a held key glides
  // the token rather than teleporting it a whole cell per press. So assert that W moved it a real
  // distance in the camera-relative direction, not that it landed exactly one grid square away.
  expect(Math.round(Math.hypot(mdx, mdy)), 'W moves the token').toBeGreaterThan(gridSize * 0.1)
  // Facing follows TRAVEL, decoupled from where the camera looks — Foundry's native contract, gated by
  // the world setting core.tokenAutoRotate (default on) and each token's lockRotation. The tolerance is
  // wide because Foundry's native walk ANIMATES: `a` is sampled while the token is still gliding, so
  // the heading derived from (b → a) trails the committed rotation slightly.
  expect(a.rotation, 'movement turns the token (it no longer keeps its start facing)').not.toBe(b.rotation)
  const facingErr = Math.abs((((a.rotation - moveHeading + 540) % 360) - 180))
  expect(facingErr, 'the token faces (roughly) its direction of travel').toBeLessThan(35)
  expect(deprecationWarnings, 'no more {teleport:true} deprecation warning — using native "walk" movement').toHaveLength(0)
  expect(midFlight.showRuler, "Foundry's native ruler (Token#showRuler) is visible while the token is moving").toBe(true)
  expect(early.miniDist, 'the 3D mini is already advancing well before Foundry\'s own animation settles').toBeGreaterThan(5)
  await hideChrome(page)
  await page.screenshot({ path: join(SHOTS, '09-character-after-move.png') })

  // (b) The mouse WHEEL ZOOMS (3rd↔1st person) — it does NOT turn. _charDist grows on
  //     scroll-out, shrinks to 0 (1st person) on scroll-in; facing is left untouched.
  const wheel = (dy) => page.evaluate((d) => window.CFGCore.overlay3D._instance._onWheel({ deltaY: d, shiftKey: false, preventDefault() {}, stopImmediatePropagation() {} }), dy)
  await reset(tokenId)
  await page.waitForTimeout(300)
  const rotBeforeWheel = (await read(tokenId)).rotation
  const distStart = await page.evaluate(() => window.CFGCore.overlay3D._instance._charDist)
  await wheel(120)
  const distOut = await page.evaluate(() => window.CFGCore.overlay3D._instance._charDist)
  for (let i = 0; i < 8; i++) await wheel(-120)
  const distIn = await page.evaluate(() => window.CFGCore.overlay3D._instance._charDist)
  console.log('[overlay-3d] wheel zoom:', JSON.stringify({ distStart, distOut, distIn }))
  expect(distOut, 'scroll-out pulls the camera back (3rd person)').toBeGreaterThan(distStart)
  expect(distIn, 'scroll-in zooms to 1st person, clamped >= 0').toBe(0)
  expect((await read(tokenId)).rotation, 'the wheel does not turn the token').toBe(rotBeforeWheel)

  // (c) Arrow keys orbit the camera (Left/Right = azimuth, Up/Down = pitch); they do
  //     not pan the map or move the token.
  await reset(tokenId)
  await page.waitForTimeout(200)
  const camState = () => page.evaluate(() => {
    const i = window.CFGCore.overlay3D._instance
    return { az: i._charAzimuth, pitch: i._charPitch }
  })
  const camB = await camState()
  await tap('ArrowLeft')
  await tap('ArrowUp')
  await page.waitForTimeout(150)
  const camA = await camState()
  console.log('[overlay-3d] arrow camera:', JSON.stringify({ camB, camA }))
  expect(camA.az !== camB.az, 'Left/Right arrow rotates the camera azimuth').toBe(true)
  expect(camA.pitch !== camB.pitch, 'Up/Down arrow tilts the camera pitch').toBe(true)

  // (c2) 3D picking: a token under a screen point resolves to its Foundry token (so
  //      hover/select/target work), and token groups are tagged with their id.
  const picked = await page.evaluate(() => {
    const inst = window.CFGCore.overlay3D._instance
    const cam = inst._orbitCamera
    const other =
      canvas.tokens.placeables.find((t) => t.name?.startsWith('Giant')) ||
      canvas.tokens.placeables.find((t) => t.id !== inst._firstPersonToken().id)
    const g = inst._viewer.tokens.get(other.id)
    cam.position.set(g.position.x + 1, g.position.y + 600, g.position.z + 1) // straight above the token
    cam.lookAt(g.position.x, g.position.y, g.position.z)
    cam.updateMatrixWorld(true)
    const v = g.position.clone().project(cam)
    const sx = ((v.x + 1) / 2) * window.innerWidth
    const sy = ((1 - v.y) / 2) * window.innerHeight
    return { otherId: other.id, tagged: g.userData?.tokenId === other.id, hitId: inst._pick(sx, sy)?.id || null }
  })
  console.log('[overlay-3d] 3D pick:', JSON.stringify(picked))
  expect(picked.tagged, 'token groups are tagged with their id for picking').toBe(true)
  expect(picked.hitId, '3D picking resolves the token under the cursor').toBe(picked.otherId)

  // (d) Subject visibility: the token model shows in 3rd person, hides in 1st.
  const subjVisible = () => page.evaluate(() => {
    const inst = window.CFGCore.overlay3D._instance
    const g = inst._viewer.tokens.get(inst._firstPersonToken().id)
    return g ? g.visible : null
  })
  await page.evaluate(() => { const i = window.CFGCore.overlay3D._instance; i._charDist = 400; i._fpStep(performance.now()) })
  await page.waitForTimeout(100)
  expect(await subjVisible(), 'subject token visible in 3rd person').toBe(true)
  await page.evaluate(() => { const i = window.CFGCore.overlay3D._instance; i._charDist = 0; i._fpStep(performance.now()) })
  await page.waitForTimeout(100)
  expect(await subjVisible(), 'subject token hidden in 1st person').toBe(false)

  // (c) Fine movement: hold W, position changes smoothly.
  await page.evaluate(() => game.settings.set('crit-fumble-core', 'overlay3dFineMovement', true))
  await reset(tokenId)
  await page.waitForTimeout(300)
  const fB = await read(tokenId)
  await key('w', 'keydown')
  await page.waitForTimeout(450)
  await key('w', 'keyup')
  await page.waitForTimeout(200)
  const fA = await read(tokenId)
  console.log('[overlay-3d] fine move:', JSON.stringify({ fB, fA }))
  expect(fA.x !== fB.x || fA.y !== fB.y, 'holding W moves continuously').toBe(true)

  // (f) Wall collision: a camera-forward step into a wall is blocked.
  await page.evaluate(async (tid) => {
    const i = window.CFGCore.overlay3D._instance
    i._charAzimuth = Math.PI // camera to the west → camera-forward (into screen) is +x (east)
    i._charAzimuthInit = true
    await game.settings.set('crit-fumble-core', 'overlay3dFineMovement', false)
    await canvas.scene.tokens.get(tid).update({ x: 1880, y: 1450 }, { teleport: true }) // by the east wall (x=2000)
  }, tokenId)
  await page.waitForTimeout(350)
  const wallB = await read(tokenId)
  await tap('w') // camera-forward = east, into the wall
  await page.waitForTimeout(400)
  const wallA = await read(tokenId)
  console.log('[overlay-3d] wall collision:', JSON.stringify({ wallB, wallA }))
  expect(wallA.x, 'a wall blocks the forward step into it').toBe(wallB.x)

  // (e) Ghost: first-person drives the token via rapid movement commits, which leave
  //     a movement-ruler path in canvas.tokens._rulerPaths. Returning to 2D must clear
  //     it — no trailing "ghost token" left on Foundry's 2D canvas.
  await page.evaluate(() => game.settings.set('crit-fumble-core', 'overlay3dFineMovement', false))
  await reset(tokenId)
  await page.waitForTimeout(250)
  await tap('w')
  await page.waitForTimeout(180)
  await tap('d')
  await page.waitForTimeout(300)
  // Leave 3D via the shared switcher (camera modes are no longer toolbar toggles).
  await page.evaluate(async () => window.CFGCore.overlay3D.setViewMode('2d'))
  await page.waitForTimeout(700)
  const ghost = await page.evaluate(() => ({
    viewMode: window.CFGCore.overlay3D.getViewMode(),
    rulerPaths: canvas.tokens._rulerPaths?.children?.length ?? -1,
  }))
  console.log('[overlay-3d] post-FP ghost check:', JSON.stringify(ghost))
  expect(ghost.viewMode, 'back to 2D after first-person').toBe('2d')
  expect(ghost.rulerPaths, 'no leftover movement-ruler ghost on the 2D canvas').toBe(0)

  // Restore default first-person setting.
  await page.evaluate(() => game.settings.set('crit-fumble-core', 'overlay3dFineMovement', false))
})
