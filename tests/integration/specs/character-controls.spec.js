/**
 * Character-view control spec — deterministic TDD for the 3D movement/camera rig.
 *
 * Drives REAL key events (by `event.code`, through Foundry's keybindings) and
 * measures internal state (`_fpCenter`, `_orbitCamera.position`, token doc
 * x/y/rotation/elevation) — so the bugs we were eyeballing (end-of-move jitter,
 * one-move input lag, facing, Q/E pole rebuild, 3D selection) become numbers.
 *
 * The whole drive+measure runs INSIDE one page.evaluate (in-page helpers): each
 * key is held until the token actually advances a cell, and camera samples are
 * taken only once the token is confirmed stationary — no cross-process round-trip
 * or async-commit races to confound the readings.
 *
 *   npx playwright test --config=integration/playwright.config.js \
 *       --project=integration --grep "character controls"
 * Headless software GL: prefix CFG3D_GL=software.
 */
import { test, expect } from '@playwright/test'
import { ensureInGame } from '../shared/foundry-login.mjs'

// az=0 → camera-forward is world −x. Foundry coords (world x→x, world z→y):
//   W(fwd)→x−SIZE  S(back)→x+SIZE  D(right)→y−SIZE  A(left)→y+SIZE
// Facing locks to the CAMERA: az=0 → heading 90.
const AZ0_HEADING = 90

test('3D character controls — camera-relative grid move, facing, no jitter, Q/E, selection', async ({ page }) => {
  test.setTimeout(240_000) // thorough in-page driver + wall-rebuild hooks under software GL
  await ensureInGame(page)
  await expect.poll(() => page.evaluate(() => !!window.CFGCore?.overlay3D), { timeout: 30_000 }).toBe(true)

  // ── Seed a flat gridded scene + one controllable 1×1 token; enter Character view. ──
  const setup = await page.evaluate(async () => {
    if (game.paused) game.togglePause(false)
    let scene = game.scenes.find((s) => s.name === 'CFG Controls')
    if (!scene) {
      scene = await Scene.create({
        name: 'CFG Controls',
        width: 2000,
        height: 2000,
        padding: 0.25,
        backgroundColor: '#33372f',
        grid: { type: 1, size: 100, distance: 5, units: 'ft' },
      })
    }
    await scene.view() // view on THIS client only — don't change the globally-active scene
    await new Promise((r) => setTimeout(r, 400))
    let doc = scene.tokens.find((t) => t.name === 'CtrlSubject')
    if (!doc) {
      ;[doc] = await scene.createEmbeddedDocuments('Token', [
        { name: 'CtrlSubject', x: 1000, y: 1000, width: 1, height: 1, rotation: 0, disposition: 1, texture: { src: 'icons/svg/mystery-man.svg' } },
      ])
    } else {
      await doc.update({ x: 1000, y: 1000, rotation: 0, elevation: 0 })
    }
    await new Promise((r) => setTimeout(r, 200))
    canvas.tokens.activate()
    canvas.tokens.get(doc.id).control({ releaseOthers: true })
    await new Promise((r) => setTimeout(r, 150))
    await game.settings.set('crit-fumble-core', 'overlay3dFineMovement', false) // grid mode
    await window.CFGCore.overlay3D.setViewMode('firstperson')
    await new Promise((r) => setTimeout(r, 1000))
    return { id: doc.id, size: canvas.dimensions.size, view: window.CFGCore.overlay3D.getViewMode() }
  })
  expect(setup.view, 'entered Character (firstperson) view').toBe('firstperson')
  const { id: TID, size: SIZE } = setup

  // Everything in one in-page driver to avoid round-trip / async-commit races.
  const M = await page.evaluate(
    async ({ TID, SIZE }) => {
      const inst = window.CFGCore.overlay3D._instance
      const doc = canvas.scene.tokens.get(TID)
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const frame = () => new Promise((r) => requestAnimationFrame(r))
      const fire = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code, key: code.replace('Key', '').toLowerCase(), bubbles: true, cancelable: true }))

      const setAz = (az) => {
        inst._charAzimuth = az
        inst._charAzimuthInit = true
        inst._fpPositionCamera(inst._firstPersonToken())
      }
      // Tap: press, wait for the single glide goal to appear, release, wait for arrival.
      // Captures az + the goal-relative-to-center so the intended grid direction is visible.
      const moveCell = async (code) => {
        const azBefore = +inst._charAzimuth.toFixed(3)
        const fine = inst._fineMovement()
        const cx = inst._fpCenter?.x ?? null
        const cy = inst._fpCenter?.y ?? null
        const sx = doc.x
        const sy = doc.y
        fire('keydown', code)
        let goal = null
        for (let i = 0; i < 30; i++) {
          await frame()
          if (inst._fpGoal) {
            goal = { gx: inst._fpGoal.x - cx, gy: inst._fpGoal.y - cy } // intended dir from center
            break
          }
        }
        fire('keyup', code)
        for (let i = 0; i < 120 && inst._fpGoal; i++) await frame() // glide arrival
        // Wait for the async doc.update to settle (position holds steady a few frames).
        let px = doc.x
        let py = doc.y
        let stable = 0
        for (let i = 0; i < 150 && stable < 6; i++) {
          await frame()
          if (doc.x === px && doc.y === py) stable++
          else {
            stable = 0
            px = doc.x
            py = doc.y
          }
        }
        return { azBefore, fine, goal, dx: doc.x - sx, dy: doc.y - sy, rot: doc.rotation }
      }
      const cameraRange = async (n) => {
        const xs = []
        const ys = []
        const zs = []
        for (let i = 0; i < n; i++) {
          const p = inst._orbitCamera.position
          xs.push(p.x)
          ys.push(p.y)
          zs.push(p.z)
          await frame()
        }
        const range = (a) => +(Math.max(...a) - Math.min(...a)).toFixed(2)
        return { rx: range(xs), ry: range(ys), rz: range(zs) }
      }

      const out = {}
      setAz(0)
      await sleep(150)

      // (A) camera-relative move + A/D polarity, sequentially (each waits for arrival).
      out.W = await moveCell('KeyW')
      out.D = await moveCell('KeyD')
      out.A = await moveCell('KeyA')

      // (B) END-OF-MOVE JITTER: token confirmed stationary → camera must hold still.
      out.S = await moveCell('KeyS')
      out.settledGoal = inst._fpGoal // should be null
      out.jitter = await cameraRange(45)

      // (C) FACING locks to camera (az=0 → heading 90), independent of move direction.
      out.facingErr = Math.abs((((out.W.rot - 90 + 540) % 360) - 180))

      // (D) Q/E vertical via a direct elevation update → the height stalk rebuilds
      //     immediately (this exercises _onUpdateToken's change-aware subject rebuild,
      //     not Foundry's keybinding, which synthetic events can't drive).
      // bbox height spans floor→mini ONLY when the stalk is rebuilt for the elevation;
      // if the mini merely floats up without a rebuild, the box stays mini-sized.
      const bboxH = () => {
        const g = inst._viewer.tokens.get(TID)
        if (!g) return null
        const box = new inst._THREE.Box3().setFromObject(g)
        return Number.isFinite(box.max.y) ? +(box.max.y - box.min.y).toFixed(1) : null
      }
      const yBefore = inst._viewer.tokens.get(TID)?.position?.y ?? null
      const hBefore = bboxH()
      await doc.update({ elevation: (doc.elevation || 0) + 10 })
      for (let i = 0; i < 30; i++) await frame() // let _fpStep detect the change + rebuild the stalk
      out.elev = { yBefore, yAfter: inst._viewer.tokens.get(TID)?.position?.y ?? null, hBefore, hAfter: bboxH(), elev: doc.elevation }

      // (E) SELECTION: forgiving screen-space pick hits the token at its projected point.
      const g = inst._viewer.tokens.get(TID)
      const v = new inst._THREE.Vector3()
      g.getWorldPosition(v).project(inst._orbitCamera)
      const sx = (v.x * 0.5 + 0.5) * window.innerWidth
      const sy = (-v.y * 0.5 + 0.5) * window.innerHeight
      out.select = { picked: inst._pickNearest(sx, sy)?.id || null, want: TID }

      // (F) LEFT-DRAG MARQUEE targets the enclosed token(s); an empty box clears targets.
      try {
        for (const t of Array.from(game.user?.targets || [])) t.setTarget(false, { releaseOthers: false })
      } catch {
        /* start clean */
      }
      inst._marqueeTarget(sx - 60, sy - 60, sx + 60, sy + 60) // box around the subject
      const targetedInBox = game.user.targets.size
      inst._marqueeTarget(sx + 500, sy + 500, sx + 560, sy + 560) // empty box → clears
      out.marquee = { targetedInBox, targetedAfterEmpty: game.user.targets.size }

      // (G) SECURITY: a CLOSED secret door renders as an indistinguishable WALL (for
      //     everyone incl. the GM); an OPENED one is revealed as a door.
      const wallDocs = await canvas.scene.createEmbeddedDocuments('Wall', [
        { c: [500, 500, 600, 500], door: 2, ds: 0 }, // closed secret door
        { c: [500, 600, 600, 600], door: 2, ds: 1 }, // opened secret door
        { c: [500, 700, 600, 700], door: 1, ds: 0 }, // ordinary door
      ])
      await sleep(120)
      const walls = inst._buildWallsJson()
      const atY = (y) => walls.find((w) => Math.abs((w.y1 + w.y2) / 2 - y) < 2 && Math.abs((w.x1 + w.x2) / 2 - 550) < 2)
      out.secretDoor = { closed: atY(500)?.kind || null, opened: atY(600)?.kind || null, normal: atY(700)?.kind || null }
      await canvas.scene.deleteEmbeddedDocuments(
        'Wall',
        wallDocs.map((d) => d.id),
      )

      // (H) PITCH direction: drag DOWN (dy>0) → look down (pitch up); drag UP → look up.
      inst._charPitch = 45
      inst._applyCharLook(0, 10)
      const afterDown = inst._charPitch
      inst._applyCharLook(0, -20)
      out.pitch = { start: 45, afterDown, afterUp: inst._charPitch }

      return out
    },
    { TID, SIZE },
  )

  console.log('[char-controls] MEASUREMENTS:\n' + JSON.stringify(M, null, 2))

  // ── Assertions (desired behavior) ──
  // (A) camera-relative + A/D, no off-by-one lag (each key moves its own direction).
  expect(Math.round(M.W.dx), 'W → one cell toward camera-forward (−x @ az0)').toBe(-SIZE)
  expect(Math.abs(M.W.dy), 'W no sideways drift').toBeLessThan(2)
  expect(Math.round(M.D.dy), 'D strafes right (−y @ az0)').toBe(-SIZE)
  expect(Math.abs(M.D.dx), 'D no forward drift').toBeLessThan(2)
  expect(Math.round(M.A.dy), 'A strafes left (+y @ az0), opposite D').toBe(SIZE)
  // (B) no camera jitter once stationary
  expect(M.settledGoal, 'no lingering glide goal after settle').toBeFalsy()
  expect(M.jitter.rx, 'camera X still').toBeLessThan(0.75)
  expect(M.jitter.ry, 'camera Y still').toBeLessThan(0.75)
  expect(M.jitter.rz, 'camera Z still').toBeLessThan(0.75)
  // (C) facing = camera
  expect(M.facingErr, 'token faces the CAMERA (heading 90 @ az0), not movement').toBeLessThan(3)
  // (D) Q/E elevation → mini rises AND the height stalk rebuilds the same beat (no lag)
  expect(M.elev.yAfter, 'mini rises when elevation increases').toBeGreaterThan(M.elev.yBefore)
  expect(M.elev.hAfter, 'the height stalk rebuilds to span floor→mini (not one move late)').toBeGreaterThan(M.elev.hBefore + 100)
  // (E) selection
  expect(M.select.picked, 'nearest-pick selects the token').toBe(M.select.want)
  // (F) left-drag marquee targets the enclosed group; empty box clears
  expect(M.marquee.targetedInBox, 'marquee targets the enclosed token(s)').toBeGreaterThanOrEqual(1)
  expect(M.marquee.targetedAfterEmpty, 'an empty marquee clears targets').toBe(0)
  // (G) secret-door security — closed secret door is a WALL; opened is revealed
  expect(M.secretDoor.closed, 'a CLOSED secret door renders as an indistinguishable wall').toBe('wall')
  expect(M.secretDoor.opened, 'an OPENED secret door is revealed as a door').toBe('door')
  expect(M.secretDoor.normal, 'an ordinary door renders as a door').toBe('door')
  // (H) vertical look is non-inverted
  expect(M.pitch.afterDown, 'drag DOWN looks down (pitch increases)').toBeGreaterThan(M.pitch.start)
  expect(M.pitch.afterUp, 'drag UP looks up (pitch decreases)').toBeLessThan(M.pitch.afterDown)
})
