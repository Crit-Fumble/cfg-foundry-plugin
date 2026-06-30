# 3D Overlay — reviewable draft (Slice 1 + live sync)

**Status:** DRAFT on branch `feat/3d-overlay-draft`. Built + verified locally overnight
2026-06-30. Not pushed. This is a proof-of-concept of the "3D inside FoundryVTT" first pass
from `docs/notes/3d-vtt-scope.md` (cfg-core-dev-tools#166) — a three.js view-skin over the
Foundry canvas, driven by Foundry's own scene/token/elevation data.

## What it does

A **"3D View" toggle** (cube icon) appears in the **Token scene-controls** (left toolbar). Toggling
it on overlays a three.js canvas over the board that renders:

- the active scene as a **ground plane** (its background image if set, else a tinted plane) + grid;
- every **token as a camera-facing billboard** using its existing 2D art, positioned at its board
  coordinates;
- **token elevation as real height** — elevated tokens float above the plane with a yellow stalk
  down to their ground position (negative elevation goes below);
- **disposition** as a colored footprint disc (green friendly / blue neutral / red hostile);
- **live multiplayer sync** — moving a token (any client) updates the 3D view, via Foundry's own
  `updateToken` / `moveToken` broadcasts. No new sync server.

Orbit with the mouse (drag = rotate, wheel = zoom). Toggle off to return to the normal 2D canvas,
which remains the source of truth the whole time.

## Review it live (Foundry is left running on :30000)

1. Open **http://localhost:30000** → Join as **Gamemaster** (no password).
2. The **"CFG 3D Test"** scene should be active (2 friendly/neutral on the ground, 1 hostile flyer
   at elevation). If not, open it from the Scenes sidebar and activate it.
3. Click the **cube toggle** in the Token controls (left). Orbit the camera. Drag a token in 2D
   first (toggle off), or change a token's elevation in its HUD, then toggle 3D to see the height.
4. To restart Foundry if needed: `cd workspaces/cfg-foundry-plugin && npm run test:foundry:up`
   (idempotent); stop with `npm run test:foundry:down`.

## Re-run the automated verification (screenshots)

```bash
cd workspaces/cfg-foundry-plugin
node tests/integration/verify-3d.mjs          # headless; screenshots → tests/test-results/
HEADED=1 node tests/integration/verify-3d.mjs  # headed, real GPU (no SW-GL warning banner)
```

It logs in, builds a scene + 3 tokens at different elevations, toggles the overlay, moves a token
to prove live sync, and asserts the toggle is registered. Screenshots:
`3d-00-foundry-2d.png` (2D baseline), `3d-01-overlay-on.png`, `3d-02-after-move.png`.

> The orange "hardware acceleration not enabled" banner in the headless screenshots is a Foundry
> warning because headless Chromium uses software GL — it will **not** appear in your real browser.

## What works vs what's stubbed

**Works (verified):** toggle registration (v14 `getSceneControlButtons` Record API), ground plane +
grid, token billboards, elevation float + stalk, disposition colors, orbit camera, lazy-loaded
three.js (only fetched on first toggle), live `updateToken` + `moveToken` sync, clean toggle-off,
all 207 plugin unit tests still pass.

**Stubbed / not yet (by design — later slices):**

- **No GLB 3D models yet** (Slice 3). Tokens are 2D-art billboards. The plan: a `flags["crit-fumble-core"].modelSrc`
  on the token + Foundry's FilePicker → per-user S3, with the billboard as fallback.
- **No walls / tiles / lighting in 3D yet** (Slice 2 structure). Only the ground + tokens are built.
- **Move = snap, not animated.** We re-sync on `moveToken`; smooth interpolation is a follow-up.
- **3D covers the board while on** (it's a view mode, not a side-by-side). Foundry UI stays usable.
- **Camera does not track Foundry's 2D pan/zoom** — it's an independent orbit camera (intentional
  for a "real 3D" view; a "locked top-down follow" mode is a possible option).

## Decisions made autonomously (flag if you'd change them)

- **Branch** `feat/3d-overlay-draft` (not `main`) — it's a draft for review.
- **Vendored three.js r184** (`scripts/lib/three.module.js` + `three.core.js`) + `OrbitControls.js`
  copied from core-browser's node_modules, import patched to the local path. ~2 MB in the repo.
  Loaded **lazily** (dynamic import on first toggle) so the plugin never depends on it at load and
  unused sessions pay nothing. **Open decision:** add a real bundler/min build vs keep vendored ESM.
- **No `module.json` change** — the service is imported by the existing `scripts/module.js` esmodule,
  so edits are picked up on a browser reload (no container restart).
- The verify harness uses a **`{teleport: true}`** move because v13+ routes x/y/elevation through the
  movement pipeline (a plain `update({x,y})` enqueues an async movement that hasn't committed yet).

## Open questions for you

- three.js packaging: vendored ESM (current) vs add a bundler + minified build?
- Wall height for Slice 2: adopt the community `flags["wall-height"].top/bottom` convention, or our
  own namespace?
- Dice: reuse **Dice So Nice!** (AGPL three.js, already the ecosystem standard) inside Foundry, or
  our own?
- Keep `tests/integration/verify-3d.mjs` as a committed manual-verify tool, or fold it into the
  Playwright `specs/` suite?

## Files

- `scripts/services/overlay-3d.js` — the Overlay3D service (renderer, sync, toggle).
- `scripts/module.js` — import + start in the `ready` hook (one import line + one start block).
- `scripts/lib/` — vendored three.js + OrbitControls.
- `tests/integration/verify-3d.mjs` — standalone Playwright verification + screenshots.
