/**
 * 3D terrain sculpting — e2e that proves we can SHAPE terrain effectively in the plugin.
 *
 * Seeds a flat heightfield on a square-grid scene, opens the 3D overlay in top-down, and drives
 * the real sculpt pipeline (_sculptBegin → _sculptApply → _sculptEnd) at the canvas centre for each
 * brush. Asserts the persisted scene flag `crit-fumble-core.heightfield` actually changed the way the
 * brush intends (raise ↑, lower ↓, undo restores). Also guards the tool-deselect fix: switching sculpt
 * tools must leave only ONE active in the rendered scene-control DOM.
 *
 * Run: npm run test:foundry:up   then   npm run test:foundry:3d
 * (this spec runs under the 3d-screenshots project — WebGL + GM storage state.)
 */
import { test, expect } from '@playwright/test'
import { ensureInGame } from '../shared/foundry-login.mjs'

const COLS = 24
const ROWS = 24

/** Open the overlay on a fresh flat-heightfield square-grid scene, in top-down. Returns nothing;
 *  leaves `window.CFGCore.overlay3D` ready + visible with a flat heightfield persisted. */
async function openFlatTerrain(page) {
  await ensureInGame(page)
  await expect.poll(() => page.evaluate(() => !!window.CFGCore?.overlay3D), { timeout: 30_000 }).toBe(true)
  await page.evaluate(async ({ cols, rows }) => {
    if (game.paused) game.togglePause(false)
    let scene = game.scenes.find((s) => s.name === 'CFG Terrain Test')
    if (!scene) {
      scene = await Scene.create({
        name: 'CFG Terrain Test',
        width: 2000,
        height: 2000,
        padding: 0,
        backgroundColor: '#3a5a40',
        grid: { type: 1, size: 100, distance: 5, units: 'ft' },
      })
    }
    if (!scene.active) await scene.activate()
    // A FLAT base heightfield so _sculptBegin has something to modify (it warns + bails otherwise).
    await scene.setFlag('crit-fumble-core', 'heightfield', { cols, rows, heights: new Array(cols * rows).fill(0) })
  }, { cols: COLS, rows: ROWS })
  await page.waitForFunction(() => globalThis.canvas?.ready === true, { timeout: 60_000 })

  await page.evaluate(() => window.CFGCore.overlay3D.setVisible(true))
  await expect.poll(() => page.evaluate(() => window.CFGCore.overlay3D.isReady()), { timeout: 30_000 }).toBe(true)
  // Overhead, unsliced — the brush raycast needs the terrain under the cursor.
  await page.evaluate(() => window.CFGCore.overlay3D._instance.setViewMode('topdown'))
  await page.evaluate(() => window.CFGCore.overlay3D.setSlice(false))
  await page.waitForTimeout(1500) // terrain mesh build
}

/** clientX/clientY at the overlay canvas centre (where top-down puts the terrain centre). */
async function canvasCentre(page) {
  return page.evaluate(() => {
    const c = document.querySelector('#cfg-3d-overlay canvas')
    const r = c.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })
}

/** Read the persisted heightfield heights (unit values). */
const heights = (page) => page.evaluate(() => canvas.scene.flags['crit-fumble-core'].heightfield.heights.slice())

/** Drive a short sculpt stroke of `mode` centred on the canvas, dragging a few dabs. */
async function stroke(page, mode, centre) {
  await page.evaluate(
    ({ mode, cx, cy }) => {
      const inst = window.CFGCore.overlay3D._instance
      inst._setSculptMode(mode)
      inst._sculptBegin({ clientX: cx, clientY: cy, button: 0 })
      for (const [dx, dy] of [[0, 0], [8, 0], [0, 8], [-8, 0]]) inst._sculptApply({ clientX: cx + dx, clientY: cy + dy })
      inst._sculptEnd()
    },
    { mode, cx: centre.x, cy: centre.y },
  )
  await page.waitForTimeout(200) // setFlag persist
}

test('terrain sculpting: raise lifts, lower drops, undo restores — persisted to the scene flag', async ({ page }) => {
  test.setTimeout(120_000)
  await openFlatTerrain(page)
  const centre = await canvasCentre(page)

  // Sanity: the brush raycast resolves onto the terrain at the canvas centre.
  const uv = await page.evaluate(({ x, y }) => window.CFGCore.overlay3D._instance._viewer.raycastTerrain(x, y), centre)
  expect(uv, 'the brush ray hits the terrain at the canvas centre (top-down framing)').not.toBeNull()

  const base = await heights(page)
  expect(base.every((h) => h === 0), 'base heightfield is flat').toBe(true)

  // RAISE.
  await stroke(page, 'raise', centre)
  const raised = await heights(page)
  const maxRaised = Math.max(...raised)
  const raisedCells = raised.filter((h) => h > 0).length
  console.log('[terrain] after raise: max=%s cells>0=%s', maxRaised, raisedCells)
  expect(maxRaised, 'raise lifted the terrain above the flat base').toBeGreaterThan(0)
  expect(raisedCells, 'the raise brush affected a patch of cells, not one point').toBeGreaterThan(3)

  // LOWER (from the raised state) — the previously-raised centre drops back down.
  await stroke(page, 'lower', centre)
  const lowered = await heights(page)
  expect(Math.max(...lowered), 'lower pulled the raised patch back down').toBeLessThan(maxRaised)

  // UNDO restores the pre-lower (raised) field.
  await page.evaluate(() => window.CFGCore.overlay3D._instance._sculptUndo())
  await page.waitForTimeout(200)
  const undone = await heights(page)
  expect(Math.max(...undone), 'undo restored the raised field').toBeCloseTo(maxRaised, 5)
})

test('square brush reaches the box corners a round brush of the same radius cannot', async ({ page }) => {
  test.setTimeout(120_000)
  await openFlatTerrain(page)
  const centre = await canvasCentre(page)

  // One raise dab, ROUND, then read how many cells were lifted.
  const dab = async (square) =>
    page.evaluate(
      ({ cx, cy, square }) => {
        const inst = window.CFGCore.overlay3D._instance
        // Reset to flat first.
        const f = canvas.scene.flags['crit-fumble-core'].heightfield
        inst._sculptSnap = false
        inst._sculptSquare = square
        inst._sculptRadius = 0.12
        inst._setSculptMode('raise')
        inst._sculptCols = f.cols
        inst._sculptRows = f.rows
        inst._sculptHeights = new Array(f.cols * f.rows).fill(0)
        inst._sculptDrag = true
        inst._sculptApply({ clientX: cx, clientY: cy })
        return inst._sculptHeights.filter((h) => h > 0).length
      },
      { cx: centre.x, cy: centre.y, square },
    )

  const roundCells = await dab(false)
  const squareCells = await dab(true)
  console.log('[terrain] round=%s square=%s cells lifted (same radius)', roundCells, squareCells)
  expect(roundCells, 'the round brush lifted a patch').toBeGreaterThan(0)
  expect(squareCells, 'the square brush covers MORE cells than the round one at the same radius (the box corners)').toBeGreaterThan(roundCells)
})

test('grid-lock: raise snaps a flat tile plateau, quantised to whole/half grid-units, one step per stroke', async ({ page }) => {
  test.setTimeout(120_000)
  await openFlatTerrain(page)
  const centre = await canvasCentre(page)

  // A single grid-locked raise dab on the centre tile (radius tiny → just that tile).
  const gridDab = async ({ half, reset }) =>
    page.evaluate(
      ({ cx, cy, half, reset }) => {
        const inst = window.CFGCore.overlay3D._instance
        const f = canvas.scene.flags['crit-fumble-core'].heightfield
        inst._sculptSnap = true
        inst._sculptSquare = true
        inst._sculptSnapHalf = half
        inst._sculptRadius = 0.01 // → 0 tiles of margin: only the tile under the cursor
        inst._setSculptMode('raise')
        inst._sculptCols = f.cols
        inst._sculptRows = f.rows
        // reset → start from FLAT (not the persisted, possibly-stepped field); else build on it.
        inst._sculptHeights = reset ? new Array(f.cols * f.rows).fill(0) : f.heights.slice()
        inst._sculptDrag = true
        inst._sculptSnapTouched = new Set()
        inst._sculptApply({ clientX: cx, clientY: cy })
        inst._sculptApply({ clientX: cx + 2, clientY: cy + 2 }) // same tile again in one stroke → no double-step
        const nz = inst._sculptHeights.filter((h) => h > 0)
        // Persist so the next stroke sees the stepped height.
        canvas.scene.setFlag('crit-fumble-core', 'heightfield', { cols: f.cols, rows: f.rows, heights: inst._sculptHeights })
        return { max: Math.max(0, ...nz), distinctRaised: [...new Set(nz.map((h) => Math.round(h * 1000) / 1000))] }
      },
      { cx: centre.x, cy: centre.y, half, reset },
    )

  // Whole-unit: one stroke lifts the tile to exactly 1.0, flat (a single distinct raised height).
  const s1 = await gridDab({ half: false, reset: true })
  console.log('[terrain] grid-lock whole step 1:', JSON.stringify(s1))
  expect(s1.max, 'a whole-unit grid step lifts the tile to exactly 1.0').toBeCloseTo(1, 5)
  expect(s1.distinctRaised, 'the tile is a FLAT plateau (one height), not a falloff mound').toEqual([1])

  // A second stroke steps once more → 2.0 (one step per stroke, not per dab — two dabs above stayed at 1).
  const s2 = await gridDab({ half: false, reset: false })
  console.log('[terrain] grid-lock whole step 2:', JSON.stringify(s2))
  expect(s2.max, 'the second stroke steps the plateau to 2.0').toBeCloseTo(2, 5)

  // Half-unit step from flat → 0.5.
  const h1 = await gridDab({ half: true, reset: true })
  console.log('[terrain] grid-lock half step:', JSON.stringify(h1))
  expect(h1.max, 'a half-unit grid step lifts the tile to 0.5').toBeCloseTo(0.5, 5)
})

test('image-less scene: 3D terrain uses the scene background colour, not hardcoded green', async ({ page }) => {
  test.setTimeout(90_000)
  await openFlatTerrain(page)
  const t = await page.evaluate(() => {
    const inst = window.CFGCore.overlay3D._instance
    const json = inst._buildTerrainJson()
    return { color: json?.color, bg: inst._sceneBackgroundColor(), src: json?.src ?? null }
  })
  console.log('[terrain] terrain json color=%s sceneBg=%s src=%s', t.color, t.bg, t.src)
  // The CFG Terrain Test scene has no background IMAGE, so the terrain tints with the scene's own
  // letterbox colour — NOT the shared core's grass-green fallback (0x6a7f52).
  expect(t.color, 'terrain carries a colour so core.ts does not fall back to green').not.toBeUndefined()
  expect(t.color, 'terrain colour == the scene background colour (3D matches 2D)').toBe(t.bg)
  expect(t.color, 'not the hardcoded grass-green').not.toBe(0x6a7f52)
})

test('tool-deselect: switching sculpt tools leaves only ONE active in the toolbar', async ({ page }) => {
  test.setTimeout(90_000)
  await openFlatTerrain(page)

  // Make the cfg-3d control group active so its sculpt tools render in the toolbar DOM.
  await page.evaluate(async () => ui.controls.activate({ control: 'cfg-3d' }))
  await page.waitForTimeout(300)

  /** data-tool → is the rendered button marked active (class or aria-pressed). */
  const sculptActive = () =>
    page.evaluate(() => {
      const out = {}
      for (const el of document.querySelectorAll('[data-tool]')) {
        const name = el.getAttribute('data-tool')
        if (!name || !name.startsWith('sculpt')) continue
        out[name] = el.classList.contains('active') || el.getAttribute('aria-pressed') === 'true'
      }
      return out
    })

  // Activate Raise through the real UI path (fires its onChange → _setSculptMode).
  await page.evaluate(async () => ui.controls.activate({ control: 'cfg-3d', toggles: { sculptRaise: true } }))
  await page.waitForTimeout(300)
  const afterRaise = await sculptActive()
  console.log('[terrain] after raise-select:', JSON.stringify(afterRaise))
  expect(await page.evaluate(() => window.CFGCore.overlay3D._instance._sculptMode)).toBe('raise')

  // Switch to Lower — Raise must DESELECT (the bug left both lit; the {reset:true} render fixes it).
  await page.evaluate(async () => ui.controls.activate({ control: 'cfg-3d', toggles: { sculptLower: true } }))
  await page.waitForTimeout(300)
  const afterLower = await sculptActive()
  console.log('[terrain] after lower-select:', JSON.stringify(afterLower))
  expect(await page.evaluate(() => window.CFGCore.overlay3D._instance._sculptMode)).toBe('lower')
  expect(afterLower.sculptLower, 'the newly-picked tool is active').toBe(true)
  expect(afterLower.sculptRaise, 'the previously-picked tool DESELECTED (no lingering highlight)').toBe(false)
})
