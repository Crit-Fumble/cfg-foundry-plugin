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

## 3D model formats

**glTF / GLB** is the supported format. Reasons it's the right choice (and beats OBJ for "just upload
it"): Blender exports it natively (File → Export → glTF 2.0 → `.glb`), it's three.js-native, and a
`.glb` is a single self-contained binary — mesh + PBR materials + textures + animation embedded — so
there are no missing `.mtl`/texture files like a lone `.obj` would have. The plugin registers
`.glb`/`.gltf` into Foundry's upload allowlist at init so users can upload via the FilePicker.

**Assign a model to a token** by setting `flags["crit-fumble-core"].modelSrc` to the file path
(optional `modelScale`, `modelRotation` in degrees). The model is auto-scaled to the token footprint
and stood on its elevation plane; tokens without a model show the 2D billboard, which is also the
fallback if a model fails to load. Verified with a generated sample
(`tests/fixtures/sample-tree.glb`; rebuild with `node tests/integration/make-sample-glb.mjs`).

OBJ would only come later as a server-side OBJ→GLB conversion if there's demand — not a direct upload.

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
grid, token billboards, elevation float + stalk, disposition colors, **glTF/GLB token models**
(`flags["crit-fumble-core"].modelSrc`, auto-scaled, billboard fallback), **walls extruded with the
`flags["wall-height"].top/bottom` convention** (sensible default height when absent), orbit camera,
lazy-loaded three.js (a single bundled file, fetched only on first toggle), live `updateToken` +
`moveToken` sync, clean toggle-off, all 207 plugin unit tests still pass.

**Stubbed / not yet (by design — later slices):**

- **No in-Foundry UI to *assign* a model yet.** GLB loading works (see "3D model formats"), but you
  set `flags["crit-fumble-core"].modelSrc` via a macro/console for now — a Token-config "3D" tab +
  FilePicker picker is the next step.
- **Tiles & lighting not in 3D yet** (walls now are — see above). The rest of Slice 2.
- **Move = snap, not animated.** We re-sync on `moveToken`; smooth interpolation is a follow-up.
- **3D covers the board while on** (it's a view mode, not a side-by-side). Foundry UI stays usable.
- **Camera does not track Foundry's 2D pan/zoom** — it's an independent orbit camera (intentional
  for a "real 3D" view; a "locked top-down follow" mode is a possible option).

## Decisions made autonomously (flag if you'd change them)

- **Branch** `feat/3d-overlay-draft` (not `main`) — it's a draft for review.
- **three.js is bundled** into a single minified `scripts/lib/three.bundle.js` (~730 KB) via
  `npm run build:three` (esbuild; `three` is a pinned devDependency). Loaded **lazily** (dynamic
  import on first toggle) so the plugin never depends on it at load and unused sessions pay nothing.
  Rebuild after bumping three with `npm run build:three`.
- **No `module.json` change** — the service is imported by the existing `scripts/module.js` esmodule,
  so edits are picked up on a browser reload (no container restart).
- The verify harness uses a **`{teleport: true}`** move because v13+ routes x/y/elevation through the
  movement pipeline (a plain `update({x,y})` enqueues an async movement that hasn't committed yet).

## Decisions applied (2026-06-30)

- **Packaging:** bundle three.js per-repo (esbuild → `scripts/lib/three.bundle.js`); **not** served
  from a core URL (that would couple the plugin to core's uptime and break offline / self-hosted
  Foundry). core-browser already carries `three` as an npm dependency, so it's bundled there by Next.
- **Walls:** use the community `flags["wall-height"].top/bottom` convention — done.
- **Dice:** deferred — no 3D dice for now (Dice So Nice! remains the option if we revisit).
- **3D model format:** glTF/GLB only (Blender-native, single-file, three.js-native); OBJ deferred to
  a possible later server-side conversion. See "3D model formats".

Still open: keep `tests/integration/verify-3d.mjs` as a committed manual-verify tool, or fold it into
the Playwright `specs/` suite?

## Files

- `scripts/services/overlay-3d.js` — the Overlay3D service (renderer, sync, toggle).
- `scripts/module.js` — import + start in the `ready` hook (one import line + one start block).
- `scripts/lib/three.bundle.js` — bundled three.js + OrbitControls + GLTFLoader (built artifact);
  `scripts/lib/three-bundle.entry.mjs` — its build entry (`npm run build:three`).
- `tests/integration/make-sample-glb.mjs` + `tests/fixtures/sample-tree.glb` — a generated sample
  model used to verify GLB loading.
- `tests/integration/verify-3d.mjs` — standalone Playwright verification + screenshots.
