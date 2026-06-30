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
- **tokens as flight stands** — a token's base ring sits on its floor (its native v14 Level's
  `elevation.base`) and the mini rises to its own absolute `elevation` on a translucent post, with a
  billboarded "+30 ft" altitude label. A tabletop flight stand, anchored to the *right floor* (not
  always the ground), which resolves the Level↔elevation split. No post when a token rests on its
  floor (the common case). All floors' tokens render at once (a 3D "dollhouse"), since the overlay
  iterates token *documents* rather than canvas placeables (which only include the viewed floor);
- **floor slice (cutaway)** — on by default: the view shows only the active floor (a *selected*
  token's Level — focus — else Foundry's viewed level) and the floors below it; floors above are
  hidden so their walls/ceilings can't block the view (TaleSpire-style). Toggle it off (the "Slice"
  button) for the full multi-floor dollhouse. Native Level maps + tokens slice precisely (they're
  document-based); walls/tiles/lights follow Foundry's placeables (the current floor), so below-floor
  walls aren't drawn yet — a doc-based follow-up if full lower-floor geometry is wanted;
- **walls anchored to their floor + clipped to the slice** — a wall's vertical band is its native v14
  Level band (worldspace, so it sits at its floor's height, not the ground), or the `wall-height`
  flag, or the building span for an all-floors wall. When slicing, a tall multi-floor wall is clipped
  to the active floor's ceiling, so only its current-floor section shows and it can't block the view;
- **elevation is worldspace + level-relative** (verified): a token's base ring sits at its Level's
  `elevation.base × pxPerUnit` and the mini at its absolute `elevation × pxPerUnit`; level maps at the
  Level's base. So a flier on the upper floor is anchored to the upper floor, not the ground;
- **GM sees all; players are bound to their tokens** — the floor is the visibility blocker, deferring
  to Foundry's own per-user computation: a GM sees every floor, a player only sees floors they can
  access (`scene.availableLevels` — where they OBSERVER a token, so no cave below when they're above
  ground) and only the tokens Foundry shows them (vision / fog of war / hidden). Tracked mode
  additionally reuses Foundry's full per-user dynamic lighting + vision + fog as the floor. Full 3D
  fog-of-war shadowing in *orbit* is a later enhancement — orbit is the GM "dollhouse";
- an **on-screen control bar** (Top-down/3D camera mode, Top/Angle/Low/Reset angles, the Slice
  toggle, and a "drag rotate · scroll zoom · right-drag pan" hint) so the camera isn't console-only;
- a **top-level "3D View" scene-control group** (its own left-toolbar button, not a tool buried
  under Tokens) with **four view modes** as radio toggles — **2D** (off), **Top-Down** (mirrors
  Foundry), **Free Camera** (orbit), **First Person** — plus Slice + camera presets. It has no canvas
  `layer`, so entering/leaving it never toggles the overlay (it persists);
- **First Person** — the camera sits at the selected token's eyes (your own token hidden). Controls:
  **click-and-drag to look** (MMO-style — the cursor stays visible, matching Foundry's own model;
  drag-x yaws the token's facing, drag-y pitches the camera up/down), **W/S** forward/back, **A/D
  strafe**.
  Per-player settings: **mouse sensitivity** and **fine movement** (hold-to-walk vs one-grid-per-
  press). **Walls block movement** (`polygonBackends.move.testCollision`). Movement runs per frame
  against a local camera pose for smoothness; the token is committed on a throttle, so it stays in
  sync. (Foundry has no rotation-degrees *setting* — its wheel uses a fixed 15°/Shift-45° convention —
  so first-person turning is mouse-look rather than a keyboard increment.)
- a **per-player "follow selected token's floor" setting** (off by default → the slice follows
  Foundry's navigated level, matching Foundry's own UI; on → selecting a token slices to its floor);
- **tiles as floors at their elevation** — multi-floor "Levels" scenes stack in 3D: each tile renders
  as a floor plane at its elevation, so a token on an upper floor stands on it. The floor band comes
  from the Levels module (`flags.levels.rangeBottom`) when present, else the tile's own `elevation`;
- **native v14 `Level` background maps** — each Level's background image renders as a floor plane at
  its `elevation.bottom` (foreground/roof at `elevation.top`); the image's own alpha (via `alphaTest`)
  lets a holed upper floor reveal the floor below. In v14 the scene's base map *is* the first Level,
  so this one path draws both the base map and every stacked floor;
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

## Tests & screenshots

**Screenshot-review suite** (Playwright spec `tests/integration/specs/overlay-3d.spec.js`):

```bash
cd workspaces/cfg-foundry-plugin
npm run test:foundry:up    # once, if Foundry isn't already running
npm run test:foundry:3d    # seeds a scene + captures 5 review angles
```

Asserts the overlay mounts, the toggle is registered, and 4 tokens + 3 walls build, then captures
`tests/test-results/3d/`: `01-foundry-2d.png` (2D baseline), `02-3d-default.png`, `03-3d-top.png`
(near top-down), `04-3d-angle.png` (3/4), `05-3d-low.png` (eye-level). The Foundry "no GPU" banner is
hidden in these shots (a headless software-GL artifact, absent in a real browser).

**Live-sync quick check** (standalone — moves a token and proves the 3D follows):

```bash
node tests/integration/verify-3d.mjs           # headless
HEADED=1 node tests/integration/verify-3d.mjs  # real GPU
```

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
- **Native v14 `Level` background/foreground maps now render** (`_buildLevelBackgrounds`) at each
  level's elevation, with image-alpha transparency so floors stack and the lower one shows through an
  upper floor's holes. Remaining level follow-ups: only `textures.fit: 'fill'` (the default) is
  honored exactly — other fit modes fall back to fill; **video** backgrounds are skipped (image-only);
  and orbit shows *all* floors at once (a later option could hide floors outside the viewed level's
  `visibility.levels` set). `alphaThreshold` is mapped to three.js `alphaTest` — a close visual
  approximation of Foundry's separate surface-occlusion pipeline, not a 1:1 reproduction.
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

Both now exist: a proper Playwright spec (`specs/overlay-3d.spec.js`, screenshot review via
`npm run test:foundry:3d`) and the standalone `verify-3d.mjs` (live-sync quick check).

## Files

- `scripts/services/overlay-3d.js` — the Overlay3D service (renderer, sync, toggle).
- `scripts/module.js` — import + start in the `ready` hook (one import line + one start block).
- `scripts/lib/three.bundle.js` — bundled three.js + OrbitControls + GLTFLoader (built artifact);
  `scripts/lib/three-bundle.entry.mjs` — its build entry (`npm run build:three`).
- `tests/integration/make-sample-glb.mjs` + `tests/fixtures/sample-tree.glb` — a generated sample
  model used to verify GLB loading.
- `tests/integration/specs/overlay-3d.spec.js` — screenshot-review spec (`npm run test:foundry:3d`);
  `tests/integration/verify-3d.mjs` — standalone live-sync quick check.
