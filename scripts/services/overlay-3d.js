/**
 * Overlay3D — a three.js 3D rendering skin over the FoundryVTT canvas (DRAFT).
 *
 * Slice 1 + a light Slice 2: renders the active scene's background as a ground
 * plane and every token as an upright billboard positioned at its board
 * coordinates and lifted by `token.document.elevation`. The 2D PIXI canvas
 * stays underneath as the source of truth — this is a *view skin*, toggled on
 * and off, never a replacement. Multiplayer comes for free: we listen to
 * Foundry's own document hooks (`updateToken` etc.), which fire on every client.
 *
 * Design notes:
 *  - three.js is loaded LAZILY (dynamic import) on first activation, so the
 *    plugin never depends on it at load time and unused sessions pay nothing.
 *  - Coordinate mapping: Foundry pixel-space (x→right, y→down) maps to three.js
 *    world space as worldX = px.x, worldZ = px.y, worldY = up (elevation).
 *  - Everything is wrapped defensively; this service must never throw into
 *    Foundry's lifecycle.
 *
 * This is a reviewable draft, not shipping code. See docs/notes/3d-vtt-scope.md
 * (cfg-core-dev-tools) for the full plan.
 */

// Pure, Foundry-free scene-JSON producers (decomposition phase 1) — no THREE, so this
// static import adds nothing to load-time cost. See overlay3d/scene-json.js.
import { buildWallsJson, buildGridJson, buildTilesJson, buildNotesJson, buildTokenJson, buildLightsJson, buildLevelsJson, buildRegionsJson, buildTerrainJson, levelBase, levelTop, levelContainingElevation, resolveActiveLevel, parseHexColor } from './overlay3d/scene-json.js'
import { applyTerrainBrush } from './overlay3d/terrain-brush.js'

const OVERLAY_ID = 'cfg-3d-overlay'

export class Overlay3D {
  constructor() {
    this._visible = false
    this._ready = false
    this._mounted = false

    /** @type {any} three.js namespace (lazy) */
    this._THREE = null
    /** @type {any} OrbitControls ctor (lazy) */
    this._OrbitControls = null
    /** @type {any} GLTFLoader ctor (lazy) */
    this._GLTFLoader = null
    /** @type {any} @crit-fumble/shared vtt-viewer createViewer() (lazy, bundled with three) */
    this._createViewerFn = null

    this._container = null
    /** @type {import('@crit-fumble/shared/vtt-viewer/core').Viewer|null} the shared render core —
     * owns the THREE.Scene/Camera/WebGLRenderer/token-Group-map; this service builds the scene
     * JSON from live Foundry canvas state and owns camera-mode/input/picking on top of it. */
    this._viewer = null
    this._renderer = null // alias: this._viewer.renderer (set in _mount)
    this._scene = null // alias: this._viewer.scene
    this._camera = null // alias: this._viewer.camera (the one perspective camera, every mode)
    this._orbitCamera = null // alias: this._viewer.camera (name kept — camera-math methods below)
    this._controls = null
    this._raf = null
    this._tickerFn = null
    /**
     * 'tracked' = true top-down perspective camera (Top Down), 'orbit' = free-look
     * (Free Camera), 'firstperson' = Character view (3rd/1st person). All three render a
     * full opaque 3D scene via the shared viewer core.
     * @type {'tracked'|'orbit'|'firstperson'}
     */
    this._mode = 'tracked'
    /** @type {((e: KeyboardEvent) => void)|null} first-person WASD key handler */
    this._keyHandler = null
    /** @type {string|null} last token the user controlled (the first-person subject) */
    this._lastTokenId = null
    this._fpSubjectId = null // character view is LOCKED to this token until an explicit switch/exit
    this._fpMoverId = null // the token _fpCenter currently drives (the SELECTED token; may differ from the subject)
    this._elevMoverId = null // mover whose elevation _subjectElev is baselined against
    /** @type {{w:boolean,a:boolean,s:boolean,d:boolean}} held WASD keys (first-person) */
    this._keys = { fwd: false, back: false, left: false, right: false }
    /** @type {((e: KeyboardEvent) => void)|null} first-person key-up handler */
    this._keyUpHandler = null
    // First-person local camera state — driven smoothly, committed to the token on a throttle.
    this._fpHeading = 0
    this._fpPitch = 0
    this._fpCenter = null
    this._fpGoal = null // grid-mode glide target cell (world px), or null when idle
    this._fpLastTick = 0
    this._fpCommitAt = 0
    this._fpDirty = false
    // Character view: 3rd-person by default (camera pulled back + up along an azimuth,
    // looking at the token), zooming to 1st person as _charDist → 0. The token aims at
    // the cursor; WASD moves relative to the camera.
    this._charDist = 0 // camera pull-back distance (world px); 0 = first person
    this._charAzimuth = 0 // direction (radians) from token → camera, in world XZ (Left/Right arrows)
    this._charAzimuthInit = false // azimuth is seeded once (behind the entry facing)
    this._charPitch = 42 // 3rd-person camera tilt in degrees (Up/Down arrows adjust)
    // Top-Down (tactical) — true top-down: a perspective camera directly above a pan
    // focus, tilted so wall sides show. Arrow keys pan the focus; the wheel zooms.
    /** @type {{x:number,z:number}|null} top-down pan focus (world XZ); null = re-seed */
    this._trackFocus = null
    this._trackDist = 0 // top-down camera distance/height (world px); wheel-controlled
    /** @type {{x:number,y:number}|null} last cursor pos (client px) — for 3D picking */
    this._cursor = null
    /** @type {((e: WheelEvent) => void)|null} character wheel-zoom handler */
    this._wheelHandler = null
    /** @type {((e: MouseEvent) => void)|null} character cursor/pick move handler */
    this._charMoveHandler = null
    /** @type {((e: MouseEvent) => void)|null} character 3D-pick click handler */
    this._charClickHandler = null
    /** @type {string|null} token id currently hovered via 3D picking */
    this._pickHoverId = null

    /** @type {boolean} floor-slice: hide floors above the active level (cutaway, like TaleSpire) */
    this._sliceFloors = true
    /** Terrain sculpt: active brush ('raise'|'lower'|'level'|'smooth'|null), radius (field
     * fraction), per-dab strength (units), and the live working height field during a stroke. */
    this._sculptMode = null
    this._sculptRadius = 0.05
    this._sculptStrength = 1.5
    this._sculptDrag = false
    this._sculptHeights = null
    /** Undo stack of height-field snapshots (units), one per stroke/generate; capped. */
    this._sculptUndoStack = []
    /** @type {{cx:number,cz:number,span:number}|null} cached scene framing */
    this._frame = null

    /** @type {Array<[string, Function]>} registered Foundry hooks for teardown */
    this._hooks = []
    this._rebuildTimer = null
    this._onResize = null
  }

  /* ------------------------------------------------------------------ */
  /*  Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  /** Register the toolbar toggle, document-sync hooks, and the public API. */
  start() {
    try {
      // Let users upload glTF/GLB models via Foundry's FilePicker — neither
      // extension is in Foundry's default upload allowlist. A token references
      // its model by path in flags["crit-fumble-core"].modelSrc.
      try {
        const C = globalThis.CONST
        if (C?.UPLOADABLE_FILE_EXTENSIONS) {
          C.UPLOADABLE_FILE_EXTENSIONS['.glb'] = 'model/gltf-binary'
          C.UPLOADABLE_FILE_EXTENSIONS['.gltf'] = 'model/gltf+json'
        }
      } catch {
        /* allowlist may be frozen on some builds — non-fatal */
      }
      this._registerSettings()
      this._registerControl()
      // Live sync (free via Foundry's broadcast). Structural changes → rebuild;
      // a token update → move just that token.
      this._on('canvasReady', () => this._onCanvasReady())
      this._on('canvasTearDown', () => this._clearScene())
      this._on('createToken', () => this._scheduleRebuild())
      this._on('deleteToken', () => this._scheduleRebuild())
      this._on('createWall', () => this._scheduleRebuild())
      this._on('updateWall', () => this._scheduleRebuild())
      this._on('deleteWall', () => this._scheduleRebuild())
      this._on('createTile', () => this._scheduleRebuild())
      this._on('updateTile', () => this._scheduleRebuild())
      this._on('deleteTile', () => this._scheduleRebuild())
      this._on('createRegion', () => this._scheduleRebuild())
      this._on('updateRegion', () => this._scheduleRebuild())
      this._on('deleteRegion', () => this._scheduleRebuild())
      this._on('createLevel', () => this._scheduleRebuild())
      this._on('updateLevel', () => this._scheduleRebuild())
      this._on('deleteLevel', () => this._scheduleRebuild())
      this._on('createNote', () => this._scheduleRebuild())
      this._on('updateNote', () => this._scheduleRebuild())
      this._on('deleteNote', () => this._scheduleRebuild())
      this._on('createAmbientLight', () => this._scheduleRebuild())
      this._on('updateAmbientLight', () => this._scheduleRebuild())
      this._on('deleteAmbientLight', () => this._scheduleRebuild())
      // Remember the controlled token (the first-person subject) + focus-follow slice.
      this._on('controlToken', (token, controlled) => {
        if (controlled && token?.id) this._lastTokenId = token.id
        // Character view stays LOCKED on its pinned subject (_fpSubjectId) — selecting another
        // token (to target/attack/cast) must NOT move the camera. The subject changes only via
        // setViewMode('firstperson') (the Token-HUD "3D View" button on another token).
        if (this._visible) this._scheduleRebuild() // rebuild so the selection ring tracks the control change
      })
      // Target reticle: rebuild when the viewer targets/untargets a token.
      this._on('targetToken', () => {
        if (this._visible) this._scheduleRebuild()
      })
      this._on('updateToken', (doc, change) => this._onUpdateToken(doc, change))
      // v13+ routes x/y/elevation/size through the movement pipeline, which
      // fires `moveToken` (often the only signal for a drag/move). Re-sync on
      // both so position + elevation stay live regardless of how it changed.
      this._on('moveToken', (doc) => this._onUpdateToken(doc))
      this._on('updateScene', () => this._scheduleRebuild())
      // Tracked mode follows Foundry's camera: re-sync on every pan/zoom.
      this._on('canvasPan', () => {
        if (this._visible && this._mode === 'tracked') {
          this._syncTrackedCamera()
          this._render()
        }
      })
      // Focus left the token → drop out of 3D back to 2D when a build/draw tool is picked
      // (players: draw tools; GMs: any scene-editing layer). 3D is for playing through a
      // token — tokens + measuring stay in 3D; editing the scene happens in 2D.
      this._on('renderSceneControls', () => {
        if (!this._visible || this._exitingBuild) return
        const name = ui?.controls?.control?.name
        const BUILD = ['regions', 'drawings', 'tiles', 'walls', 'sounds', 'lighting', 'notes']
        if (BUILD.includes(name)) {
          this._exitingBuild = true // guard against the control re-render our own exit triggers
          Promise.resolve(this.setViewMode('2d')).finally(() => {
            this._exitingBuild = false
          })
        }
      })

      this._exposeApi()
      // Scene controls may already have been prepared before this ready-time
      // registration (the `getSceneControlButtons` hook only re-fires on a
      // reset render), so force a re-prepare to make the toggle appear now.
      try {
        ui?.controls?.render?.({ reset: true })
      } catch {
        /* ui.controls not ready yet — its first render will include our hook */
      }
      console.log('CFG Core | Overlay3D registered (toggle in the Token controls)')
    } catch (err) {
      console.error('CFG Core | Overlay3D.start failed (non-fatal):', err)
    }
  }

  _exposeApi() {
    window.CFGCore = window.CFGCore || {}
    window.CFGCore.overlay3D = {
      setVisible: (v) => this.setVisible(v),
      toggle: () => this.setVisible(!this._visible),
      isVisible: () => this._visible,
      isReady: () => this._ready,
      rebuild: () => this.rebuild(),
      setView: (preset) => this.setView(preset),
      setMode: (m) => this.setMode(m),
      getMode: () => this._mode,
      setViewMode: (m) => this.setViewMode(m),
      getViewMode: () => this._currentViewMode(),
      getSubjectId: () => this._fpSubjectId,
      setSlice: (on) => this.setSlice(on),
      getActiveLevel: () => this._activeLevel()?.id ?? null,
      destroy: () => this.destroy(),
      tokenCount: () => this._viewer?.tokens?.size ?? 0,
      _instance: this,
    }
  }

  _on(hook, fn) {
    Hooks.on(hook, fn)
    this._hooks.push([hook, fn])
  }

  /** Toggle the 3D view on/off. Async because three.js loads on first show. */
  async setVisible(visible) {
    visible = !!visible
    if (visible === this._visible && this._mounted) return
    this._visible = visible
    try {
      if (visible) {
        this._showLoading() // three.js bundle + first scene build can take a beat — don't look hung
        await this._mount()
        await this.rebuild()
        if (this._container) this._container.style.display = 'block'
        this._applyMode() // active camera + input routing + UI-hide (orbit only)
        this._updateControlBar()
        this._startLoop()
        this._hideLoading()
      } else {
        this._stopLoop()
        this._setFpInput(false)
        this._hideTokenHud()
        this._clearMoveRuler() // drop the movement path + distance label
        this._clearSelectionBrackets() // drop the selection corner brackets
        this._wasMoving = false
        this._teardownSharedControls() // stop the shared controller's rAF while hidden
        document.body.classList.remove('cfg-3d-active')
        if (this._container) this._container.style.display = 'none'
      }
      this._syncControlState()
    } catch (err) {
      this._hideLoading()
      console.error('CFG Core | Overlay3D.setVisible failed:', err)
    }
  }

  /* ------------------------------------------------------------------ */
  /*  three.js mount                                                     */
  /* ------------------------------------------------------------------ */

  async _ensureThree() {
    if (this._THREE) return
    // Lazy: only fetch the bundled three.js (~780 KB, built via `npm run
    // build:three`) when the user actually opens the 3D view. Also carries the
    // shared @crit-fumble/shared vtt-viewer render core (createViewer) — it
    // doesn't import 'three' itself (THREE is injected below), so bundling it
    // here adds no second copy of three.js.
    const bundle = await import('../lib/three.bundle.js')
    this._THREE = bundle.THREE
    this._OrbitControls = bundle.OrbitControls
    this._GLTFLoader = bundle.GLTFLoader
    this._createViewerFn = bundle.createViewer
    this._createViewerControlsFn = bundle.createViewerControls
  }

  async _mount() {
    if (this._mounted) return
    this._injectUiStyle()
    await this._ensureThree()
    const THREE = this._THREE

    const container = document.createElement('div')
    container.id = OVERLAY_ID
    // Sit above the PIXI board (#board, z-index 0) but BELOW Foundry's UI
    // panels (#ui-left / #ui-right are z-index 30), so the scene controls,
    // sidebar, hotbar, nav, players, and chat keep rendering over the 3D view.
    Object.assign(container.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '25',
      display: 'none',
      pointerEvents: 'auto', // OrbitControls needs the events while 3D is up
      background: '#0b0e13',
    })
    document.body.appendChild(container)
    this._container = container

    // Scene/camera/renderer/token-Group-map now live in the shared viewer core;
    // this service builds the scene JSON from live Foundry canvas state (rebuild())
    // and owns camera-mode/input/picking on top of the core's exposed camera/scene.
    const viewer = this._createViewerFn({
      element: container,
      THREE,
      width: window.innerWidth,
      height: window.innerHeight,
      GLTFLoader: this._GLTFLoader,
      powerPreference: this._gpuPreference(),
      shadows: this._shadowsEnabled(),
      // Adaptive render quality (#166): 'auto' detects a tier from the GPU/device
      // (Steam Deck / integrated / software step down; a thin fragment-uniform
      // budget hard-caps lights so the shader still compiles), or a user-pinned
      // tier. The core owns pixelRatio, the light budget, and a runtime frame
      // governor from here on — so we no longer setPixelRatio() ourselves.
      quality: this._qualityPreference(),
      // Frame-rate cap (#166) — default 15fps: a steady 15 is smoother and far
      // lighter on old/integrated GPUs than an uncapped, stuttering 30-40.
      // Player-settable ("3D View — Frame rate cap"); null = uncapped.
      fpsCap: this._fpsCapPreference(),
    })
    this._viewer = viewer
    this._renderer = viewer.renderer
    this._scene = viewer.scene
    this._camera = viewer.camera
    this._orbitCamera = viewer.camera

    const renderer = viewer.renderer
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.setClearColor(0x000000, 0) // transparent when scene.background is null
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    // The core sizes the drawing buffer only (device-pixel-ratio aware) — size the
    // canvas element itself via CSS so it fills the fixed-position container.
    Object.assign(renderer.domElement.style, { width: '100%', height: '100%', display: 'block' })

    viewer.camera.far = 5_000_000
    viewer.camera.updateProjectionMatrix()
    const controls = new this._OrbitControls(viewer.camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.maxPolarAngle = Math.PI * 0.495 // don't drop below the ground plane
    this._controls = controls

    // Lighting is built from the scene's own settings in _buildLightsJson().
    this._buildControlBar()
    this._buildCompass()

    this._onResize = () => this._resize()
    window.addEventListener('resize', this._onResize)
    this._mounted = true
  }

  _resize() {
    if (!this._viewer) return
    this._viewer.resize(window.innerWidth, window.innerHeight)
    if (this._mode === 'tracked') this._syncTrackedCamera()
    this._render()
  }

  /* ------------------------------------------------------------------ */
  /*  Scene construction                                                 */
  /* ------------------------------------------------------------------ */

  /** Pixels per grid distance unit (e.g. px per foot) — converts elevation. */
  _pxPerUnit() {
    const d = canvas?.dimensions
    if (!d || !d.distance) return canvas?.dimensions?.size || 100
    return d.size / d.distance
  }

  /** The scene rectangle (image area) in absolute canvas pixels. */
  _sceneRect() {
    const d = canvas?.dimensions || {}
    const r = d.sceneRect || {}
    return {
      x: r.x ?? d.sceneX ?? 0,
      y: r.y ?? d.sceneY ?? 0,
      width: r.width ?? d.sceneWidth ?? d.width ?? 2000,
      height: r.height ?? d.sceneHeight ?? d.height ?? 2000,
    }
  }

  /**
   * The scene's configured background ("letterbox") color, read deprecation-free
   * from the active Level (Scene#backgroundColor is deprecated in v14). Returns a
   * value THREE.Color accepts (an 0xRRGGBB number or "#rrggbb").
   */
  _sceneBackgroundColor() {
    try {
      // Foundry's actual canvas clear color (scene background, darkness-adjusted —
      // matches what Foundry displays); fall back to the configured color.
      const env = canvas?.environment?.colors
      const c = env?.rendererBackground ?? env?.sceneBackground
      if (c != null) return Number(c)
    } catch {
      /* ignore */
    }
    try {
      const levels = canvas?.scene?.levels?.contents ?? (Array.isArray(canvas?.scene?.levels) ? canvas.scene.levels : [])
      for (const lvl of levels) {
        const col = lvl?.background?.color
        if (col != null) return Number(col) // Foundry Color is a Number subclass
      }
    } catch {
      /* ignore */
    }
    try {
      const raw = canvas?.scene?.toObject?.()
      const hex = raw?.levels?.[0]?.background?.color || raw?.backgroundColor
      if (hex) return hex
    } catch {
      /* ignore */
    }
    return 0x0b0e13
  }

  /**
   * Mirror the scene's own background color onto the container's DOM style (the
   * page background peeking around the canvas before the first frame paints).
   * The THREE scene.background itself is set from `rebuild()`'s JSON via
   * `viewer.loadScene()` — this is DOM chrome only.
   */
  _applyBackground() {
    if (!this._THREE || !this._container) return
    try {
      const color = new this._THREE.Color(this._sceneBackgroundColor())
      this._container.style.background = `#${color.getHexString()}`
    } catch {
      /* keep the existing background on failure */
    }
  }

  /**
   * Best-effort background image path. In v14 the background moved to `Level`
   * documents — we read those (and the live PIXI texture / raw source) and
   * deliberately avoid the deprecated `Scene#background` getter.
   */
  _backgroundSrc() {
    const s = canvas?.scene
    if (!s) return null
    try {
      const levels = s.levels?.contents ?? (Array.isArray(s.levels) ? s.levels : [])
      for (const lvl of levels) {
        if (lvl?.background?.src) return lvl.background.src
      }
    } catch {
      /* ignore */
    }
    // Deprecation-free fallback: the live PIXI background texture URL.
    try {
      const res = canvas?.primary?.background?.texture?.baseTexture?.resource
      if (res?.url) return res.url
    } catch {
      /* ignore */
    }
    // Last resort: raw source data (does not invoke the deprecated getter).
    try {
      const raw = typeof s.toObject === 'function' ? s.toObject() : null
      return raw?.background?.src || raw?.levels?.[0]?.background?.src || null
    } catch {
      return null
    }
  }

  /**
   * Rebuild the entire 3D scene from the live Foundry canvas: build a scene JSON
   * from live placeables/documents (Foundry-domain resolution — asset URLs, Level
   * bands, wall-height flags, per-player visibility) and hand it to the shared
   * viewer core, which owns the actual THREE-object construction.
   */
  async rebuild() {
    if (!this._mounted) await this._mount()
    if (!canvas?.ready || !canvas.scene) {
      this._ready = false
      return
    }
    this._applyBackground()

    const rect = this._sceneRect()
    const cx = rect.x + rect.width / 2
    const cz = rect.y + rect.height / 2
    const { ambient, lights } = this._buildLightsJson()

    // Iterate token DOCUMENTS (every floor) — not canvas placeables, which only
    // include the currently-viewed Level. A multi-floor 3D view shows them all.
    const tokens = []
    for (const doc of canvas.scene?.tokens || []) {
      const t = this._tokenJson(doc)
      if (t) tokens.push(t)
    }

    this._viewer.loadScene({
      bounds: { width: rect.width, height: rect.height, x: rect.x, y: rect.y },
      background: { color: this._sceneBackgroundColor() },
      grid: this._buildGridJson(),
      // Native v14 Level backgrounds — in v14 the scene's base map IS the first
      // Level, so this covers the base map + every stacked floor at its own
      // elevation. `_buildLevelsJson` falls back to the scene's plain background
      // image when there are no Level docs at all (degenerate/programmatic scene);
      // an empty array here lets the core's flat-color ground apply (blank-slate).
      levels: this._buildLevelsJson(),
      ambient,
      lights,
      tokens,
      walls: this._buildWallsJson(),
      tiles: this._buildTilesJson(),
      notes: this._buildNotesJson(),
      regions: this._buildRegionsJson(),
      terrain: this._buildTerrainJson(),
    })

    // Cache framing for the orbit camera; the tracked camera follows Foundry.
    this._frame = { cx, cz, span: Math.max(rect.width, rect.height) }
    if (this._mode === 'orbit') this.setView('default')
    else this._syncTrackedCamera()
    this._ready = true
    this._render()
  }

  /**
   * Move the camera to a named review angle: 'default' | 'top' | 'angle' |
   * 'low'. Also a natural hook for a future in-UI view switcher.
   */
  setView(preset = 'default') {
    if (!this._orbitCamera || !this._controls || !this._frame) return
    const { cx, cz, span } = this._frame
    const views = {
      default: { x: cx, y: span * 0.85, z: cz + span * 0.95 },
      top: { x: cx, y: span * 1.5, z: cz + span * 0.04 },
      angle: { x: cx + span * 0.75, y: span * 0.6, z: cz + span * 0.75 },
      low: { x: cx + span * 0.1, y: span * 0.18, z: cz + span * 1.05 },
    }
    const v = views[preset] || views.default
    this._orbitCamera.position.set(v.x, v.y, v.z)
    this._controls.target.set(cx, 0, cz)
    this._controls.update()
    // Keep the shared controller's orbit pivot in sync with the framed centre (its
    // right-drag focus-pivot refines this on the first orbit).
    if (this._sharedControls) {
      this._sharedControls.orbit3d.target.set(cx, 0, cz)
      this._sharedControls.orbit3d.update()
    }
    this._render()
  }

  /** Free Camera: attach the shared @crit-fumble/shared ViewerControls (left-select,
   * right-drag orbit, arrows/WASD pan, Q/E elevation, wheel zoom, focus-pivot). One
   * scheme shared with the platform viewer. Created on entry, disposed on leave. */
  _ensureSharedControls() {
    if (this._sharedControls || !this._viewer || !this._createViewerControlsFn) return
    this._sharedControls = this._createViewerControlsFn(this._viewer, {
      THREE: this._THREE,
      OrbitControls: this._OrbitControls,
      mode: 'free',
      allowedModes: ['free'],
      getBounds: () => {
        const r = this._sceneRect()
        return { width: r.width, height: r.height, x: r.x, y: r.y }
      },
      onSelect: (id) => {
        if (!id) return
        try {
          canvas?.tokens?.get(id)?.control({ releaseOthers: true })
        } catch {
          /* permission — ignore */
        }
      },
    })
    // Foundry scenes can be enormous — don't clamp the zoom-out; keep orbit above ground.
    const o = this._sharedControls.orbit3d
    o.maxDistance = 5_000_000
    o.maxPolarAngle = Math.PI * 0.495
  }

  _teardownSharedControls() {
    this._sharedControls?.dispose()
    this._sharedControls = null
  }

  /**
   * TRUE top-down: the perspective camera directly overhead the pan focus, looking
   * straight down — matching Foundry's own map orientation, just in 3D. Arrow keys pan
   * the focus; the wheel changes _trackDist (height). `up` must be a horizontal axis
   * here (the view direction is vertical — world-up would leave the camera's
   * screen-space rotation undefined); -Z keeps Foundry-north up on screen.
   */
  _syncTrackedCamera() {
    const cam = this._orbitCamera
    if (!cam) return
    if (!this._trackFocus) this._trackFocus = this._defaultTrackFocus()
    const size = canvas?.dimensions?.size || 100
    if (!this._trackDist) this._trackDist = size * 12
    const f = this._trackFocus
    cam.up.set(0, 0, -1)
    cam.position.set(f.x, this._trackDist, f.z)
    cam.lookAt(f.x, 0, f.z)
    cam.fov = 50
    cam.updateProjectionMatrix()
  }

  /**
   * Grab-pan the top-down view by a screen-pixel delta — the world point under the cursor
   * tracks it, like dragging Foundry's canvas. Screen px → world px via the camera's ground
   * footprint (2·height·tan(fov/2) over the viewport height). Signs are the inverse of the
   * arrow-key pan (drag the map, don't push the focus).
   */
  _trackPan(dx, dy) {
    if (!this._trackFocus) this._trackFocus = this._defaultTrackFocus()
    if (!this._trackDist) this._trackDist = (canvas?.dimensions?.size || 100) * 12
    const H = this._container?.clientHeight || window.innerHeight || 900
    const wpp = (2 * this._trackDist * Math.tan((50 / 2) * (Math.PI / 180))) / H
    this._trackFocus.x -= dx * wpp
    this._trackFocus.z -= dy * wpp
    this._syncTrackedCamera()
    this._render()
  }

  /** Default top-down pan focus (world XZ): the controlled token, else the scene centre. */
  _defaultTrackFocus() {
    const tok = this._firstPersonToken()
    if (tok?.center) return { x: tok.center.x, z: tok.center.y }
    const d = canvas?.dimensions
    return { x: (d?.width || 2000) / 2, z: (d?.height || 2000) / 2 }
  }

  /**
   * Position the first-person camera at the controlled token's eyes, looking the
   * way the token faces. Foundry stores facing as `rotation`, where the movement
   * angle = rotation + 90° and rotation 0 = south (down) — so the look vector in
   * world XZ is (cos(rot+90°), sin(rot+90°)). Falls back to the first token.
   */
  /**
   * The token first-person follows: the currently-controlled token, else the
   * last one controlled (switching to the 3D control group releases the canvas
   * selection), else an owned token, else any.
   */
  _firstPersonToken() {
    // Character view is LOCKED on its pinned subject — selecting another token (to target,
    // cast, etc.) must not move the camera. The subject changes only via setViewMode('firstperson').
    if (this._fpSubjectId) {
      const s = canvas?.tokens?.get?.(this._fpSubjectId)
      if (s?.document) return s
    }
    const controlled = canvas?.tokens?.controlled?.[0]
    if (controlled?.document) return controlled
    if (this._lastTokenId) {
      const t = canvas?.tokens?.get?.(this._lastTokenId)
      if (t?.document) return t
    }
    const placeables = canvas?.tokens?.placeables || []
    return placeables.find((t) => t.document?.isOwner) || placeables[0] || null
  }

  /**
   * First-person movement controller, run per frame. Drives a LOCAL camera
   * heading + ground point so continuous turn/move stay smooth (60fps) while the
   * token document is committed on a throttle (~11/s). Discrete steps (15°/45°
   * turn, one-grid move) are applied on keydown. Walls block all movement.
   */
  _fpStep(now) {
    const cam = this._orbitCamera
    if (!cam) return
    // The camera rides the SUBJECT (the character you're viewing through, pinned by the lock).
    // Movement drives the SELECTED token — Foundry's move bindings (WASD) + native Q/E
    // elevation. Usually the same token, but selecting e.g. a familiar lets you move it
    // without leaving your character's view. _fpCenter tracks whichever is being moved.
    const subject = this._firstPersonToken()
    if (!subject?.document) return
    const controlled = canvas?.tokens?.controlled?.[0]
    const mover = controlled?.document ? controlled : subject
    const sameSubject = mover.id === subject.id
    // Movement gate: paused, or in combat and not the mover's turn (GM/ref bypasses). The
    // camera/look still works — only token movement is locked. Clear held keys + any glide.
    const km = this._keys
    if ((km.fwd || km.back || km.left || km.right) && !this._movementAllowed(mover)) {
      this._keys = { fwd: false, back: false, left: false, right: false }
      this._fpGoal = null
      this._notifyMovementBlocked()
    }
    // _fpCenter is the moved token's smooth position; re-anchor when the selection changes.
    if (this._fpCenter == null || this._fpMoverId !== mover.id) {
      this._fpSyncLocalFromToken(mover)
      this._fpMoverId = mover.id
      this._fpGoal = null
      this._fpDirty = false
    }
    if (!this._charAzimuthInit) {
      // Seed the camera behind the subject's entry facing; it then stays put while the
      // token turns to the cursor independently (left-drag orbit can adjust it later).
      this._charAzimuth = (((this._fpHeading + 270) % 360) * Math.PI) / 180
      this._charAzimuthInit = true
    }
    const dt = this._fpLastTick ? Math.min(0.1, (now - this._fpLastTick) / 1000) : 0
    this._fpLastTick = now
    const k = this._keys
    const moving = k.fwd || k.back || k.left || k.right
    if (moving && this._fpCenter) {
      if (!this._wasMoving) {
        this._moveOrigin = { x: this._fpCenter.x, y: this._fpCenter.y } // ruler starts here
        this._moveTokenId = mover.id
      }
      this._moveLastAt = now
    }
    this._wasMoving = moving
    if (this._fineMovement()) {
      // Fine (off-grid) movement — smooth, camera-relative, integrated per frame.
      if (dt > 0 && moving) {
        let mx = 0
        let mz = 0
        for (const sem of ['fwd', 'back', 'left', 'right']) {
          if (!k[sem]) continue
          const d = this._fpMoveDir(sem)
          mx += d.x
          mz += d.z
        }
        const len = Math.hypot(mx, mz)
        if (len > 0) {
          const size = canvas?.dimensions?.size || 100
          const speed = size * 3.5 // px/sec (~3.5 grids/sec)
          const dest = { x: this._fpCenter.x + (mx / len) * speed * dt, y: this._fpCenter.y + (mz / len) * speed * dt }
          if (!this._moveBlocked(this._fpCenter, dest)) {
            this._fpCenter = dest
            this._fpDirty = true
          }
        }
      }
      if (this._fpDirty) {
        if (now - (this._fpCommitAt || 0) > 90) this._fpCommitNow(mover) // throttle writes
      } else if (!moving) {
        this._syncExternalMove(mover) // idle → follow genuine external moves only
      }
    } else {
      // Grid-locked movement (Foundry default on a gridded scene): glide smoothly
      // cell-to-cell, each destination snapped to the grid. Hold to walk cell-by-
      // cell, tap for one cell — the token never lands off-grid.
      this._fpGridWalk(mover, dt)
      if (!this._fpGoal && !moving) this._syncExternalMove(mover) // idle → genuine external moves only
    }
    // Facing: the moved token looks where the camera looks ONLY when it IS the subject (your
    // character faces the camera). A separately-selected token (familiar) keeps its own
    // facing — _fpCommitNow persists _fpHeading, so freeze it to the mover's rotation.
    if (sameSubject) {
      this._fpHeading = (((Math.atan2(-Math.sin(this._charAzimuth), -Math.cos(this._charAzimuth)) * 180) / Math.PI - 90) % 360 + 360) % 360
    } else {
      this._fpHeading = Number(mover.document.rotation) || 0
    }
    // Elevation (native Q/E on the selected token) changed → rebuild the moved token so its
    // height stalk/base match the new floor gap THIS frame (the pole length is baked at build
    // time). Tracked per-mover so switching selection re-baselines.
    const elevNow = Number(mover.document.elevation || 0)
    if (this._subjectElev === undefined || this._elevMoverId !== mover.id) {
      this._subjectElev = elevNow
      this._elevMoverId = mover.id
      this._fpActiveLevelId = this._activeLevel()?.id ?? null // baseline the floor with the elevation
    } else if (elevNow !== this._subjectElev) {
      this._subjectElev = elevNow
      this._rebuildSubject(mover)
      // Vision follows the SUBJECT (the camera): only re-slice the scene when the moved token
      // IS the subject and it crosses a floor band. Guarded to multi-level scenes.
      if (sameSubject && (canvas?.scene?.levels?.size || 0) > 1) {
        const lvlNow = this._activeLevel()?.id ?? null
        if (lvlNow !== this._fpActiveLevelId) {
          this._fpActiveLevelId = lvlNow
          this._scheduleRebuild()
        }
      }
    }
    this._charUpdateSubjectVisibility(subject) // fade the camera SUBJECT's own mini in 1st person
    this._fpSyncSubjectVisual(mover) // the MOVED token's mini rides _fpCenter
    if (!sameSubject) {
      const mg = this._viewer?.tokens?.get?.(mover.id) // a separately-moved token stays visible
      if (mg) mg.visible = true
      this._syncTokenVisualToDoc(subject) // keep the (non-mover) subject's mini pinned to its own doc position
    }
    this._fpPositionCamera(subject) // camera stays on the subject
  }

  /** Position a token's 3D mini at its committed document centre — for a token that is the
   * camera subject but NOT the active mover (rides its own doc position, not the mover's
   * _fpCenter), so it never freezes mid-glide or strands on an external move. */
  _syncTokenVisualToDoc(tok) {
    const g = this._viewer?.tokens?.get?.(tok.id)
    const c = tok?.center
    if (!g || !c) return
    const elevPx = this._fpGroundPx(c) + Number(tok.document.elevation || 0) * this._pxPerUnit()
    g.position.set(c.x, elevPx, c.y)
  }

  /** Rebuild the subject's 3D group (remove + re-add) so its height stalk/base reflect
   * the current elevation — the actively-driven first-person subject skips the normal
   * position-only updateToken rebuild, so its stalk is refreshed here on elevation change. */
  _rebuildSubject(tok) {
    try {
      const id = tok.id
      this._removeToken(id)
      const fresh = canvas?.scene?.tokens?.get?.(id) || tok.document
      const t = this._tokenJson(fresh)
      if (t) this._viewer.applyDelta({ tokens: [t] })
    } catch {
      /* ignore — the next elevation change or hook rebuild corrects it */
    }
  }

  /**
   * Move the subject's own 3D mini to `_fpCenter` directly, every frame — the same
   * local state the camera already tracks smoothly. The throttled document commit
   * (~11/s, see `_fpCommitNow`) is for persistence/multiplayer sync; without this,
   * the mini would only move once per commit (a visible ~90ms step), even though
   * the camera moves at 60fps — this is what actually reads as "choppy" in 3rd
   * person. Ring/stalk offsets (computed at add-time from elevation/floorElevation)
   * go stale only if elevation changes mid-move; the next hook-driven rebuild
   * corrects that — a non-issue for ordinary flat-ground walking.
   */
  _fpSyncSubjectVisual(tok) {
    const g = this._viewer?.tokens?.get?.(tok.id)
    if (!g || !this._fpCenter) return
    // Base rides the heightmap: ground = terrain surface at the CURRENT position + the token's
    // own (above-ground) elevation, so the character walks up/down the terrain automatically.
    const elevPx = this._fpGroundPx() + Number(tok.document.elevation || 0) * this._pxPerUnit()
    g.position.set(this._fpCenter.x, elevPx, this._fpCenter.y)
  }

  /** Heightmap surface height (px) under the first-person character (at `_fpCenter`); 0 when
   * there is no terrain field — so flat-floor scenes behave exactly as before. */
  _fpGroundPx(pos) {
    const c = pos || this._fpCenter
    if (!c) return 0
    const t = this._sampleTerrain(c.x, c.y)
    return t != null ? t * this._pxPerUnit() : 0
  }

  /** A unit move direction (world XZ) for a semantic move (from Foundry's move
   * bindings), relative to the CAMERA: fwd = into the screen (the way the camera
   * looks), back = away, right/left = strafe. The camera azimuth is the reference. */
  _fpMoveDir(sem) {
    // _charAzimuth points from the token TO the camera; "forward" (into the screen)
    // is the opposite — the direction the camera looks.
    const f = { x: -Math.cos(this._charAzimuth), z: -Math.sin(this._charAzimuth) }
    const r = { x: -f.z, z: f.x } // screen-right = forward × up in world XZ
    if (sem === 'fwd') return f
    if (sem === 'back') return { x: -f.x, z: -f.z }
    if (sem === 'right') return r
    if (sem === 'left') return { x: -r.x, z: -r.z }
    return { x: 0, z: 0 }
  }

  /**
   * Position the character camera: 3rd-person (pulled back + up along the azimuth,
   * looking at the token) by default, converging to 1st-person (at the eyes, looking
   * where the token faces) as _charDist → 0.
   */
  _fpPositionCamera(tok) {
    const cam = this._orbitCamera
    if (!cam || !this._fpCenter) return
    const size = canvas?.dimensions?.size || 100
    // Focus: if this token is the actively-driven mover, ride the smooth _fpCenter; otherwise
    // (the camera subject differs from the moved token) use its committed centre so the camera
    // stays put on the character while a separately-selected token moves.
    const focus = tok?.id === this._fpMoverId ? this._fpCenter : tok?.center || this._fpCenter
    // Eye height sits on the terrain surface under the subject (+ any above-ground elevation),
    // so entering Character view no longer starts below the heightmap / clips through it.
    const eyeY = this._fpGroundPx(focus) + (Number(tok.document.elevation) || 0) * this._pxPerUnit() + size * 0.9
    const cx = focus.x
    const cz = focus.y
    cam.up.set(0, 1, 0)
    if (this._charDist < size * 0.5) {
      // First person: at the eyes, looking along the CAMERA direction (mouse-look) —
      // never the token facing, so walking/strafing can't spin the view. Pitch tilts
      // the look up/down (42° = level, matching the 3rd-person neutral).
      const fx = -Math.cos(this._charAzimuth)
      const fz = -Math.sin(this._charAzimuth)
      const pitchRad = (42 - (this._charPitch || 42)) * (Math.PI / 180)
      const ch = Math.cos(pitchRad)
      cam.position.set(cx, eyeY, cz)
      cam.lookAt(cx + fx * ch * size, eyeY + Math.sin(pitchRad) * size, cz + fz * ch * size)
    } else {
      // Third person: camera behind + above along the azimuth, looking at the token.
      const pitch = (this._charPitch || 42) * (Math.PI / 180)
      const horiz = this._charDist * Math.cos(pitch)
      const vert = this._charDist * Math.sin(pitch)
      cam.position.set(cx + Math.cos(this._charAzimuth) * horiz, eyeY + vert, cz + Math.sin(this._charAzimuth) * horiz)
      cam.lookAt(cx, eyeY, cz)
    }
    cam.updateProjectionMatrix()
  }

  /** 3D picking: the Foundry Token whose 3D model is under a client-px point, or null. */
  _pick(clientX, clientY) {
    const THREE = this._THREE
    const cam = this._orbitCamera
    if (!THREE || !cam || !this._viewer?.tokens?.size) return null
    cam.updateMatrixWorld()
    const w = window.innerWidth || 1
    const h = window.innerHeight || 1
    const ndc = { x: (clientX / w) * 2 - 1, y: -((clientY / h) * 2 - 1) }
    const ray = new THREE.Raycaster()
    ray.setFromCamera(ndc, cam)
    const groups = []
    for (const g of this._viewer.tokens.values()) if (g?.visible) groups.push(g)
    const hits = ray.intersectObjects(groups, true)
    if (!hits.length) return null
    let o = hits[0].object
    while (o && !o.userData?.tokenId) o = o.parent
    const id = o?.userData?.tokenId
    return id ? canvas?.tokens?.get?.(id) || null : null
  }

  /**
   * Forgiving pick for CLICKS: the nearest token whose 3D group projects within a
   * screen-space tolerance of the cursor. 3D minis are small/billboarded, so an exact
   * ray hit is fiddly (the main reason selection feels harder than 2D); this makes a
   * click *near* a token select it, while the nearest-wins rule avoids grabbing the
   * wrong one. Hover still uses the exact `_pick` so highlighting stays crisp.
   */
  _pickNearest(clientX, clientY) {
    const THREE = this._THREE
    const cam = this._orbitCamera
    if (!THREE || !cam || !this._viewer?.tokens?.size) return null
    cam.updateMatrixWorld()
    const w = window.innerWidth || 1
    const h = window.innerHeight || 1
    const size = canvas?.dimensions?.size || 100
    const v = new THREE.Vector3()
    const e = new THREE.Vector3()
    let bestId = null
    let bestScore = Infinity // normalized d/tolerance — fair across token sizes
    for (const [id, g] of this._viewer.tokens.entries()) {
      if (!g?.visible) continue
      g.getWorldPosition(v)
      // Tolerance = the token's screen-space footprint radius (min 44px). A big creature's
      // footprint ring is far larger than its 3D mesh, so a center-only 44px test misses it;
      // this lets a click anywhere inside the ring select it.
      const doc = canvas?.tokens?.get?.(id)?.document
      const rWorld = Math.max(doc?.width || 1, doc?.height || 1) * size * 0.5
      e.set(v.x + rWorld, v.y, v.z).project(cam)
      v.project(cam)
      if (v.z > 1) continue // behind the camera
      const cx = (v.x * 0.5 + 0.5) * w
      const cy = (-v.y * 0.5 + 0.5) * h
      const rScreen = Math.max(44, Math.hypot((e.x * 0.5 + 0.5) * w - cx, (-e.y * 0.5 + 0.5) * h - cy))
      const d = Math.hypot(cx - clientX, cy - clientY)
      if (d > rScreen) continue // click is outside this token's footprint
      const score = d / rScreen
      if (score < bestScore) {
        bestScore = score
        bestId = id
      }
    }
    return bestId ? canvas?.tokens?.get?.(bestId) || null : null
  }

  /** Hover a 3D token → mirror it to Foundry's hover (native Target key + highlight). */
  _onPickMove(event) {
    if (!this._visible) return // 3D picking works in every 3D mode
    this._cursor = { x: event.clientX, y: event.clientY }
    const tok = this._pick(event.clientX, event.clientY)
    const id = tok?.id || null
    if (id === this._pickHoverId) return
    const prev = this._pickHoverId && canvas?.tokens?.get?.(this._pickHoverId)
    if (prev) {
      try {
        prev._onHoverOut?.(event)
      } catch {
        /* ignore */
      }
    }
    this._pickHoverId = id
    if (tok) {
      try {
        tok._onHoverIn?.(event, { hoverOutOthers: true })
      } catch {
        /* ignore */
      }
    }
    if (this._container) this._container.style.cursor = tok ? 'pointer' : ''
  }

  /** Click a 3D token → select (left) or target (right / Shift-left) — native selection.
   * Falls back to the forgiving screen-space pick when the exact ray misses. */
  _onPickClick(event) {
    if (!this._visible) return // 3D picking works in every 3D mode
    const tok = this._pick(event.clientX, event.clientY) || this._pickNearest(event.clientX, event.clientY)
    if (!tok) return
    event.preventDefault?.()
    event.stopImmediatePropagation?.()
    if (event.button === 2 || event.shiftKey) {
      try {
        tok.setTarget(!tok.isTargeted, { releaseOthers: !event.shiftKey })
      } catch {
        /* permission — ignore */
      }
    } else if (event.button === 0) {
      try {
        tok.control({ releaseOthers: true })
      } catch {
        /* permission — ignore */
      }
    }
  }

  /**
   * Character-view mouse, matching Foundry's button roles as closely as the 3D view
   * allows:
   *   - LEFT drag  → a selection MARQUEE: on release, target every token inside the
   *                  box (AoE on a group of enemies). A bare left click selects the
   *                  single token under it.
   *   - RIGHT drag → mouse-look (Foundry uses right-drag to pan the canvas). A bare
   *                  right click targets the single token under it.
   * Free-Camera and Top-Down keep their existing hover-on-move + select-on-down.
   */
  _onCharDown(event) {
    if (!this._visible) return
    if (this._mode === 'orbit' && this._sharedControls) return // shared ViewerControls owns Free Camera input
    this._hideTokenHud() // a new scene interaction dismisses an open token HUD
    // Sculpt: a left-drag paints the active terrain brush (raycast → height field).
    if (this._sculptActive() && event.button === 0) {
      event.preventDefault?.()
      this._sculptBegin(event)
      return
    }
    // Top-Down (Foundry-like): LEFT-drag = marquee multi-select (bare left-click selects /
    // moves); RIGHT-drag = pan the map (bare right-click = token HUD). Resolve bare clicks on
    // mouseup so a drag doesn't fire the click.
    if (this._mode === 'tracked') {
      if (event.button === 0) {
        this._charDrag = { mode: 'marquee', button: 0, x: event.clientX, y: event.clientY, sx: event.clientX, sy: event.clientY, moved: false }
      } else if (event.button === 2) {
        this._charDrag = { mode: 'trackpan', button: 2, x: event.clientX, y: event.clientY, sx: event.clientX, sy: event.clientY, moved: false }
        event.preventDefault?.() // suppress the browser context menu
      }
      return
    }
    if (this._mode !== 'firstperson') {
      this._onPickClick(event) // Free: select on mousedown, unchanged
      return
    }
    if (event.button === 2) {
      this._charDrag = { mode: 'look', x: event.clientX, y: event.clientY, sx: event.clientX, sy: event.clientY, button: 2, moved: false }
      event.preventDefault?.()
    } else if (event.button === 0) {
      this._charDrag = { mode: 'marquee', x: event.clientX, y: event.clientY, sx: event.clientX, sy: event.clientY, button: 0, moved: false }
      event.preventDefault?.()
    }
  }

  /** Mouse move: right-drag looks, left-drag draws the marquee, otherwise hover-pick. */
  _onCharMove(event) {
    if (this._mode === 'orbit' && this._sharedControls) return // shared ViewerControls owns Free Camera input
    if (this._sculptActive()) {
      // Show the brush ring under the cursor; drag applies dabs. No pick/pan while sculpting.
      this._viewer?.showBrushCursor?.(event.clientX, event.clientY, this._sculptRadius)
      if (this._sculptDrag) this._sculptApply(event)
      return
    }
    const d = this._charDrag
    if (d && d.mode === 'trackpan') {
      const dx = event.clientX - d.x
      const dy = event.clientY - d.y
      d.x = event.clientX
      d.y = event.clientY
      if (!d.moved && Math.hypot(event.clientX - d.sx, event.clientY - d.sy) > 3) {
        d.moved = true
        document.body.style.cursor = 'grabbing'
      }
      if (d.moved) this._trackPan(dx, dy)
      return
    }
    if (d && d.mode === 'look') {
      if (!d.moved && Math.hypot(event.clientX - d.sx, event.clientY - d.sy) > 4) d.moved = true
      const dx = event.clientX - d.x
      const dy = event.clientY - d.y
      d.x = event.clientX
      d.y = event.clientY
      if (d.moved) this._applyCharLook(dx, dy)
      return
    }
    if (d && d.mode === 'marquee') {
      if (!d.moved && Math.hypot(event.clientX - d.sx, event.clientY - d.sy) > 4) d.moved = true
      if (d.moved) this._marqueeUpdate(d.sx, d.sy, event.clientX, event.clientY)
      return
    }
    this._onPickMove(event)
  }

  /** Mouse up: finish the marquee (target the enclosed group) or resolve a bare click. */
  _onCharUp(event) {
    if (this._mode === 'orbit' && this._sharedControls) return // shared ViewerControls owns Free Camera input
    if (this._sculptDrag) {
      this._sculptEnd()
      return
    }
    const d = this._charDrag
    this._charDrag = null
    if (d && d.mode === 'trackpan') {
      // Top-Down right button: drag pans; a bare right-click opens the token HUD.
      document.body.style.cursor = ''
      if (!d.moved && d.button === 2) this._showTokenHud(event)
      return
    }
    if (d && d.mode === 'marquee') {
      this._marqueeClear()
      if (this._mode === 'tracked') {
        // Top-Down: drag box multi-SELECTS (saves / applying damage); SHIFT+drag TARGETS the
        // group (attacks / AoE); a bare left-click selects / moves; shift+click targets one.
        if (d.moved) {
          if (event.shiftKey) this._marqueeTarget(d.sx, d.sy, event.clientX, event.clientY)
          else this._marqueeSelect(d.sx, d.sy, event.clientX, event.clientY)
        } else if (event.shiftKey) this._onPickClick(event) // shift+left → target one
        else {
          const tok = this._pick(event.clientX, event.clientY) || this._pickNearest(event.clientX, event.clientY)
          if (tok) {
            try {
              tok.control({ releaseOthers: true }) // click on/near a token → select it
            } catch {
              /* permission — ignore */
            }
          } else this._moveControlledTo(this._pickGround(event.clientX, event.clientY)) // clearly-empty ground → move
        }
      } else {
        // Character view: a drag box TARGETS the group (AoE); a bare left-click selects one.
        if (d.moved) this._marqueeTarget(d.sx, d.sy, event.clientX, event.clientY)
        else this._onPickClick(event)
      }
      return
    }
    if (d && d.mode === 'look' && !d.moved) this._showTokenHud(event) // firstperson bare right-click → token HUD
  }

  /** Draw/resize the on-screen selection marquee (viewport-fixed overlay). */
  _marqueeUpdate(sx, sy, cx, cy) {
    let el = this._marqueeEl
    if (!el) {
      el = document.createElement('div')
      el.style.cssText = 'position:fixed;z-index:60;pointer-events:none;border:1px solid #ffb300;background:rgba(255,179,0,0.12);border-radius:2px'
      document.body.appendChild(el)
      this._marqueeEl = el
    }
    el.style.left = `${Math.min(sx, cx)}px`
    el.style.top = `${Math.min(sy, cy)}px`
    el.style.width = `${Math.abs(cx - sx)}px`
    el.style.height = `${Math.abs(cy - sy)}px`
  }

  /** Remove the marquee overlay element. */
  _marqueeClear() {
    if (this._marqueeEl) {
      this._marqueeEl.remove()
      this._marqueeEl = null
    }
  }

  /** Every visible token whose screen-space FOOTPRINT (its ring — center projection + a
   * footprint-radius) intersects the drag box. Footprint-vs-box, not center-in-box, so any
   * token the box visibly touches counts (matches what the user sees). */
  _tokensInBox(sx, sy, cx, cy) {
    const out = []
    const THREE = this._THREE
    const cam = this._orbitCamera
    if (!THREE || !cam || !this._viewer?.tokens?.size) return out
    cam.updateMatrixWorld()
    const w = window.innerWidth || 1
    const h = window.innerHeight || 1
    const size = canvas?.dimensions?.size || 100
    const minX = Math.min(sx, cx)
    const maxX = Math.max(sx, cx)
    const minY = Math.min(sy, cy)
    const maxY = Math.max(sy, cy)
    const v = new THREE.Vector3()
    const e = new THREE.Vector3()
    for (const [id, g] of this._viewer.tokens.entries()) {
      if (!g?.visible) continue
      g.getWorldPosition(v)
      const doc = canvas?.tokens?.get?.(id)?.document
      const rWorld = Math.max(doc?.width || 1, doc?.height || 1) * size * 0.5
      e.set(v.x + rWorld, v.y, v.z).project(cam)
      v.project(cam)
      if (v.z > 1) continue // behind the camera
      const px = (v.x * 0.5 + 0.5) * w
      const py = (-v.y * 0.5 + 0.5) * h
      const r = Math.hypot((e.x * 0.5 + 0.5) * w - px, (-e.y * 0.5 + 0.5) * h - py)
      // circle (token footprint) vs box (marquee): nearest box point within r → intersects
      const nx = Math.max(minX, Math.min(px, maxX))
      const ny = Math.max(minY, Math.min(py, maxY))
      if (Math.hypot(px - nx, py - ny) <= r) out.push(id)
    }
    return out
  }

  /** Target every token the drag box touches (releasing prior targets); an empty box clears
   * all targets — like Foundry's marquee, but targeting (AoE / group attacks). */
  _marqueeTarget(sx, sy, cx, cy) {
    const ids = this._tokensInBox(sx, sy, cx, cy)
    if (!ids.length) {
      try {
        for (const t of Array.from(game.user?.targets || [])) t.setTarget(false, { releaseOthers: false })
      } catch {
        /* ignore */
      }
      return
    }
    let first = true
    for (const id of ids) {
      const tok = canvas?.tokens?.get?.(id)
      if (!tok) continue
      try {
        tok.setTarget(true, { releaseOthers: first })
        first = false
      } catch {
        /* permission — ignore */
      }
    }
  }

  /** Control (multi-select) every token the drag box touches; an empty box releases the
   * selection — Foundry's marquee, for Top-Down group selection (saves, applying damage). */
  _marqueeSelect(sx, sy, cx, cy) {
    const ids = this._tokensInBox(sx, sy, cx, cy)
    if (!ids.length) {
      try {
        canvas?.tokens?.releaseAll?.()
      } catch {
        /* ignore */
      }
      return
    }
    let first = true
    for (const id of ids) {
      const tok = canvas?.tokens?.get?.(id)
      if (!tok) continue
      try {
        tok.control({ releaseOthers: first }) // controllable = owned (GM: all); non-owned no-ops
        first = false
      } catch {
        /* permission — ignore */
      }
    }
  }

  /**
   * Apply an MMO look-drag delta (client px) to the character camera. Azimuth in
   * radians, pitch in degrees; the constants match the demo's 0.006 rad/px feel
   * (0.006 rad ≈ 0.344°). Polarity is the confirmed one: drag right swings the
   * camera right, drag down looks down.
   */
  _applyCharLook(dx, dy) {
    this._charAzimuth += dx * 0.006
    this._charAzimuthInit = true // user is steering — stop auto-seeding from heading
    // Non-inverted vertical: mouse UP (dy<0) → lower pitch → look up; mouse DOWN → look down.
    this._charPitch = Math.max(5, Math.min(85, this._charPitch + dy * 0.344))
    const tok = this._firstPersonToken()
    if (tok) this._fpPositionCamera(tok) // camera direction is the azimuth in both 3rd & 1st person
  }

  /** Show the subject token's model in 3rd person; hide it in 1st (the camera is
   * inside it). Restored to visible when leaving character view. */
  _charUpdateSubjectVisibility(tok) {
    const size = canvas?.dimensions?.size || 100
    const g = this._viewer?.tokens?.get?.(tok.id)
    if (g) g.visible = this._charDist >= size * 0.5
  }

  /** Initialize the local camera state from a token (centre + facing). */
  _fpSyncLocalFromToken(tok) {
    const doc = tok.document
    const { w, h } = this._tokenSizePx(doc)
    this._fpCenter = tok.center ? { x: tok.center.x, y: tok.center.y } : { x: (doc.x || 0) + w / 2, y: (doc.y || 0) + h / 2 }
    this._fpHeading = Number(doc.rotation) || 0
  }

  /**
   * Idle re-anchor: snap `_fpCenter` to the token ONLY on a genuine EXTERNAL move (a
   * GM drag, a teleport, another client). Our own just-committed cell already equals
   * `_fpCenter` to within rounding, so re-anchoring to it every idle frame would
   * re-nudge the camera by sub-pixels continuously — the residual end-of-move camera
   * jitter. A few-px threshold ignores that while still catching real moves.
   */
  _syncExternalMove(tok) {
    if (!this._fpCenter) return this._fpSyncLocalFromToken(tok)
    // Our own commit is an ASYNC doc.update: for a short window after it the token
    // still reads its PRE-move centre. Re-anchoring `_fpCenter` to that stale value is
    // exactly the post-move camera jitter AND the "moves in the last input" lag — the
    // mini/camera get yanked back a cell until the update lands. Trust the local centre
    // during that window; after it, a real difference is a genuine external move.
    const now = typeof performance !== 'undefined' ? performance.now() : 0
    if (now - (this._fpCommitAt || 0) < 300) return
    const c = tok.center
    if (c && Math.hypot(c.x - this._fpCenter.x, c.y - this._fpCenter.y) > 3) this._fpSyncLocalFromToken(tok)
  }

  /**
   * Commit the local camera state (position + facing) to the token document. No
   * `teleport` — Foundry's default "walk" movement action animates the sprite and
   * shows its native measuring ruler during the move (matching the 2D view), and
   * natively clips movement at a wall if our own `_moveBlocked` pre-check ever
   * disagrees with its real collision resolution. The CAMERA and the subject's own
   * 3D mini are never driven by this commit's animation — they're already updated
   * every frame from `_fpCenter` (see `_fpStep`/`_fpSyncSubjectVisual`) — this call
   * is purely for persistence + multiplayer sync, decoupled from local smoothness.
   */
  _fpCommitNow(tok) {
    try {
      const doc = tok.document
      const { w, h } = this._tokenSizePx(doc)
      // animate:false — we already render the motion locally (the glide + camera
      // follow `_fpCenter` every frame), so Foundry's native token animation is
      // redundant and, running underneath, fires mid-flight update hooks that fight
      // our per-frame sync. Commit the final cell position instantly instead.
      doc.update(
        { x: Math.round(this._fpCenter.x - w / 2), y: Math.round(this._fpCenter.y - h / 2), rotation: Math.round(this._fpHeading) },
        { animate: false },
      )
    } catch {
      /* permission / movement rejected — ignore */
    }
    this._fpCommitAt = typeof performance !== 'undefined' ? performance.now() : 0
    this._fpDirty = false
  }

  /**
   * Grid-locked walk, run per frame in grid mode. Glides `_fpCenter` toward the
   * current goal cell (`_fpGoal`); on arrival — or when idle with a key held — picks
   * the next cell one grid step along the camera-relative input and snaps it to the
   * grid. Grid-locked like Foundry, yet fluid: the camera and the subject's 3D mini
   * follow `_fpCenter` every frame, so there's no per-cell teleport.
   */
  _fpGridWalk(tok, dt) {
    const size = canvas?.dimensions?.size || 100
    // 1) Glide toward the active goal cell.
    if (this._fpGoal) {
      const gx = this._fpGoal.x - this._fpCenter.x
      const gy = this._fpGoal.y - this._fpCenter.y
      const dist = Math.hypot(gx, gy)
      const step = size * 4 * Math.max(0, dt) // ~4 cells/sec glide
      if (dist <= step || dist < 1) {
        this._fpCenter = { x: this._fpGoal.x, y: this._fpGoal.y }
        this._fpGoal = null
        this._fpDirty = true
        this._fpCommitNow(tok) // arrived on a cell → persist
      } else {
        this._fpCenter = { x: this._fpCenter.x + (gx / dist) * step, y: this._fpCenter.y + (gy / dist) * step }
        this._fpDirty = true
      }
    }
    // 2) Not gliding + a key held → start the next cell. Quantize the camera-relative
    // move to one of 8 grid directions FIRST, then step exactly one cell that way
    // (snapped) — crisp and predictable, never a fuzzy diagonal that snaps oddly.
    if (!this._fpGoal) {
      const k = this._keys
      let mx = 0
      let mz = 0
      for (const sem of ['fwd', 'back', 'left', 'right']) {
        if (!k[sem]) continue
        const d = this._fpMoveDir(sem)
        mx += d.x
        mz += d.z
      }
      if (mx || mz) {
        const oct = Math.round(Math.atan2(mz, mx) / (Math.PI / 4)) * (Math.PI / 4)
        const gdir = { x: Math.round(Math.cos(oct)), z: Math.round(Math.sin(oct)) }
        if (gdir.x || gdir.z) {
          const raw = { x: this._fpCenter.x + gdir.x * size, y: this._fpCenter.y + gdir.z * size }
          const dest = this._snapToGrid(raw, tok)
          if (!this._moveBlocked(this._fpCenter, dest) && Math.hypot(dest.x - this._fpCenter.x, dest.y - this._fpCenter.y) > 1) {
            this._fpGoal = dest // facing stays locked to the camera (set in _fpStep), not movement
          }
        }
      }
    }
  }

  /**
   * Snap a world-px point to the grid using the token's footprint (Foundry-native),
   * so grid-mode moves stay grid-aligned for any token size. On a gridless scene
   * `getSnappedPoint` returns the point unchanged → movement stays free.
   */
  _snapToGrid(point, tok) {
    const grid = canvas?.grid
    if (!grid?.getSnappedPoint) return point
    try {
      const { w, h } = this._tokenSizePx(tok.document)
      const M = CONST.GRID_SNAPPING_MODES
      const tl = grid.getSnappedPoint({ x: point.x - w / 2, y: point.y - h / 2 }, { mode: (M && M.TOP_LEFT_CORNER) || 0, resolution: 1 })
      if (tl && Number.isFinite(tl.x) && Number.isFinite(tl.y)) return { x: tl.x + w / 2, y: tl.y + h / 2 }
    } catch {
      /* fall through to the raw point */
    }
    return point
  }

  /** Whether a move origin→dest crosses a movement-blocking wall. */
  _moveBlocked(origin, dest) {
    try {
      const backend = CONFIG?.Canvas?.polygonBackends?.move
      if (backend?.testCollision) return !!backend.testCollision(origin, dest, { type: 'move', mode: 'any' })
      if (canvas?.walls?.checkCollision) return !!canvas.walls.checkCollision({ A: origin, B: dest }, { type: 'move', mode: 'any' })
    } catch {
      /* on error, don't block movement */
    }
    return false
  }

  /**
   * Enable/disable character-view input: WASD (capture phase, preempting Foundry's
   * keys) for camera-relative movement, press-and-drag MOUSE-LOOK to rotate the
   * camera (MMO style — see `_applyCharLook`), and the WHEEL to zoom between 3rd and
   * 1st person. A non-dragged press is a click that selects/targets the token under
   * it. Arrow keys still nudge azimuth/pitch as a keyboard fallback.
   */
  _setFpInput(on) {
    if (on && !this._keyHandler) {
      this._keyHandler = (e) => this._onKeyDown(e)
      this._keyUpHandler = (e) => this._onKeyUp(e)
      this._wheelHandler = (e) => this._onWheel(e)
      this._charMoveHandler = (e) => this._onCharMove(e)
      this._charClickHandler = (e) => this._onCharDown(e)
      this._charUpHandler = (e) => this._onCharUp(e)
      this._charCtxHandler = (e) => e.preventDefault() // no browser menu over the 3D canvas (right-click = look / pan / token HUD)
      window.addEventListener('keydown', this._keyHandler, true)
      window.addEventListener('keyup', this._keyUpHandler, true)
      this._container?.addEventListener('wheel', this._wheelHandler, { passive: false, capture: true })
      this._container?.addEventListener('mousemove', this._charMoveHandler)
      this._container?.addEventListener('mousedown', this._charClickHandler)
      this._container?.addEventListener('contextmenu', this._charCtxHandler)
      window.addEventListener('mouseup', this._charUpHandler, true) // catch drag-release outside the canvas
      this._charDrag = null
      this._keys = { fwd: false, back: false, left: false, right: false }
      this._controlMap = this._buildControlMap() // honor the user's Foundry keybindings
      this._fpCenter = null
      this._fpGoal = null
      this._fpLastTick = 0
      this._fpPitch = 0
      this._charDist = (canvas?.dimensions?.size || 100) * 4 // 3rd-person by default
      this._charAzimuthInit = false
      this._charPitch = 42
      this._cursor = null
      this._pickHoverId = null
      if (this._container) this._container.style.cursor = ''
    } else if (!on && this._keyHandler) {
      window.removeEventListener('keydown', this._keyHandler, true)
      window.removeEventListener('keyup', this._keyUpHandler, true)
      this._container?.removeEventListener('wheel', this._wheelHandler, { capture: true })
      this._container?.removeEventListener('mousemove', this._charMoveHandler)
      this._container?.removeEventListener('mousedown', this._charClickHandler)
      this._container?.removeEventListener('contextmenu', this._charCtxHandler)
      window.removeEventListener('mouseup', this._charUpHandler, true)
      this._keyHandler = null
      this._keyUpHandler = null
      this._wheelHandler = null
      this._charMoveHandler = null
      this._charClickHandler = null
      this._charUpHandler = null
      this._charCtxHandler = null
      this._charDrag = null
      this._marqueeClear() // drop any in-progress selection rectangle
      this._cursor = null
      // clear any 3D-pick hover mirrored onto Foundry
      try {
        const hov = this._pickHoverId && canvas?.tokens?.get?.(this._pickHoverId)
        if (hov) hov._onHoverOut?.()
      } catch {
        /* ignore */
      }
      this._pickHoverId = null
      this._keys = { fwd: false, back: false, left: false, right: false }
      if (this._container) this._container.style.cursor = ''
      // The subject model is hidden in 1st person — restore it for the other modes.
      try {
        const sub = this._firstPersonToken?.()
        const g = sub && this._viewer?.tokens?.get?.(sub.id)
        if (g) g.visible = true
      } catch {
        /* ignore */
      }
      // First-person drives the token via rapid movement commits, which leave a
      // movement-ruler "ghost" path in canvas.tokens._rulerPaths that Foundry does
      // NOT clear on its own — a trailing duplicate token on the 2D canvas. Clear
      // it on exit. (Verified live: only _rulerPaths.removeChildren() removes it.)
      try {
        canvas?.tokens?._rulerPaths?.removeChildren?.()
      } catch {
        /* nothing to clear */
      }
    }
  }

  /**
   * Character view: the mouse WHEEL zooms — pulling the camera back into 3rd person or
   * in toward 1st person (_charDist → 0). Turning is by the cursor, not the wheel.
   */
  _onWheel(event) {
    if (!this._visible) return
    // Sculpting: the wheel sizes the brush instead of zooming the camera.
    if (this._sculptActive()) {
      event.preventDefault?.()
      event.stopImmediatePropagation?.()
      const step = event.deltaY > 0 ? 1 / 1.15 : 1.15
      this._sculptRadius = Math.max(0.02, Math.min(0.5, this._sculptRadius * step))
      return
    }
    const m = this._mode
    const size = canvas?.dimensions?.size || 100
    if (m === 'tracked') {
      event.preventDefault?.()
      event.stopImmediatePropagation?.()
      if (!this._trackDist) this._trackDist = size * 12
      const stepPx = size * 1.5
      this._trackDist = Math.max(size * 3, Math.min(size * 40, this._trackDist + (event.deltaY > 0 ? stepPx : -stepPx)))
      this._syncTrackedCamera()
      this._render()
      return
    }
    if (m !== 'firstperson') return // Free (orbit) → OrbitControls handles the wheel
    const tok = this._firstPersonToken()
    if (!tok?.document) return
    event.preventDefault?.()
    event.stopImmediatePropagation?.()
    if (this._fpCenter == null) this._fpSyncLocalFromToken(tok)
    const stepPx = size * 0.75
    this._charDist = Math.max(0, Math.min(size * 10, this._charDist + (event.deltaY > 0 ? stepPx : -stepPx)))
    this._fpPositionCamera(tok)
    this._maybeResliceOnFpZoom() // crossing the eye-height threshold flips the enclosed lens
  }

  /**
   * Character-view / Top-Down keydown, routed through Foundry's OWN keybindings so
   * user rebindings are honored (see `_buildControlMap`). Character view: the move
   * bindings (WASD by default) drive camera-relative grid movement; the pan bindings
   * (arrows) turn the camera; the zoom bindings change the 3rd↔1st distance. Modified
   * chords (Ctrl/Meta/Alt) and unmapped keys stay native (target, ruler, E/Q, copy…).
   * Ignored while typing in a field.
   */
  _onKeyDown(event) {
    if (!this._visible) return
    // Undo a sculpt stroke / Generate with Cmd/Ctrl-Z while a sculpt tool is active — handled
    // before the mode + chord guards so it works in any 3D view and preempts Foundry.
    if (this._sculptActive() && (event.key === 'z' || event.key === 'Z') && (event.ctrlKey || event.metaKey) && !event.shiftKey) {
      event.preventDefault()
      event.stopImmediatePropagation()
      this._sculptUndo()
      return
    }
    const m = this._mode
    if (m !== 'firstperson' && m !== 'tracked') return // Free/2D: leave keys native
    const t = event.target
    const tag = (t?.tagName || '').toLowerCase()
    if (tag === 'input' || tag === 'textarea' || t?.isContentEditable) return
    if (event.ctrlKey || event.metaKey || event.altKey) return // let Foundry handle chords
    const sem = (this._controlMap || {})[event.code]
    if (!sem) return // unmapped → native (target, ruler, elevation E/Q, …)

    // Top-Down: the pan bindings shift the tracked-camera focus; token-move keys are native.
    if (m === 'tracked') {
      if (sem !== 'yawLeft' && sem !== 'yawRight' && sem !== 'pitchUp' && sem !== 'pitchDown') return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (!this._trackFocus) this._trackFocus = this._defaultTrackFocus()
      const step = (canvas?.dimensions?.size || 100) * 1.5
      if (sem === 'yawLeft') this._trackFocus.x -= step
      else if (sem === 'yawRight') this._trackFocus.x += step
      else if (sem === 'pitchUp') this._trackFocus.z -= step
      else this._trackFocus.z += step
      this._syncTrackedCamera()
      this._render()
      return
    }

    // Character view.
    const tok = this._firstPersonToken()
    if (!tok?.document) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (this._fpCenter == null) this._fpSyncLocalFromToken(tok)
    if (sem === 'fwd' || sem === 'back' || sem === 'left' || sem === 'right') {
      this._keys[sem] = true // integrated per frame (_fpGridWalk / fine path)
      return
    }
    // Camera controls: pan bindings turn the camera, zoom bindings dolly 3rd↔1st.
    const yaw = (Math.PI / 180) * 6
    const size = canvas?.dimensions?.size || 100
    if (sem === 'yawLeft') this._charAzimuth -= yaw
    else if (sem === 'yawRight') this._charAzimuth += yaw
    else if (sem === 'pitchUp') this._charPitch = Math.max(5, this._charPitch - 4) // arrow up → look up
    else if (sem === 'pitchDown') this._charPitch = Math.min(85, this._charPitch + 4)
    else if (sem === 'zoomIn') this._charDist = Math.max(0, this._charDist - size * 0.75)
    else if (sem === 'zoomOut') this._charDist = Math.min(size * 10, this._charDist + size * 0.75)
    this._charAzimuthInit = true // the user is steering the camera now
    this._fpPositionCamera(tok)
    if (sem === 'zoomIn' || sem === 'zoomOut') this._maybeResliceOnFpZoom()
  }

  /** Release a held move key. Grid mode commits on each cell arrival, so no commit
   * here (committing mid-glide would snap the token to an off-cell spot — the "re-
   * move into the final square" jitter); only fine (off-grid) mode commits on release. */
  _onKeyUp(event) {
    const sem = (this._controlMap || {})[event.code]
    if (sem !== 'fwd' && sem !== 'back' && sem !== 'left' && sem !== 'right') return
    this._keys[sem] = false
    const idle = !this._keys.fwd && !this._keys.back && !this._keys.left && !this._keys.right
    if (this._fineMovement() && idle && this._fpDirty) {
      // Commit to the token _fpCenter actually belongs to (the active mover), NOT the live
      // selection — if the selection changed since the last _fpStep, committing to the current
      // controlled token would write THIS token's smooth position onto the wrong one (teleport).
      const mover = canvas?.tokens?.get?.(this._fpMoverId) || this._firstPersonToken()
      if (mover?.document) this._fpCommitNow(mover)
    }
  }

  /**
   * Build a { event.code → semantic } map from Foundry's LIVE keybindings, so
   * character-view controls follow whatever the user has bound (not hardcoded WASD).
   * Movement (moveUp/Down/Left/Right) → camera-relative fwd/back/left/right; camera
   * pan (panUp/Down/Left/Right) → pitch/yaw; zoom (zoomIn/Out) → dolly. Anything not
   * listed here (target, ruler, ascend/descend, selectAll, …) is left to Foundry.
   */
  _buildControlMap() {
    const map = {}
    const add = (action, sem) => {
      try {
        for (const b of game.keybindings.get('core', action) || []) if (b?.key) map[b.key] = sem
      } catch {
        /* action not registered in this Foundry build */
      }
    }
    add('moveUp', 'fwd')
    add('moveDown', 'back')
    add('moveLeft', 'left')
    add('moveRight', 'right')
    add('panUp', 'pitchUp')
    add('panDown', 'pitchDown')
    add('panLeft', 'yawLeft')
    add('panRight', 'yawRight')
    add('zoomIn', 'zoomIn')
    add('zoomOut', 'zoomOut')
    return map
  }

  /**
   * Every 3D mode now renders a full opaque scene (our own ground/floor/walls/tokens +
   * 3D lighting). Nothing is transparent-over-Foundry anymore — top-down is our own 3D
   * render, not a flat mirror — so Foundry's 2D never shows through to duplicate.
   */
  _foundryFloor() {
    return false
  }

  /** Apply the current camera mode: active camera, input routing, UI-hide. */
  _applyMode() {
    const m = this._mode
    // All 3D modes are opaque, use the perspective camera, and capture the mouse for 3D
    // picking. cfg-3d-active hides only the canvas-anchored #hud/#tooltip; the hotbar +
    // sidebar + controls stay above the overlay (z-30).
    this._camera = this._orbitCamera
    // Free Camera routes through the SHARED ViewerControls (@crit-fumble/shared) so the
    // control scheme lives in one place across the plugin + the platform viewer. The
    // native OrbitControls no longer drives orbit; create the shared controller on entry
    // and tear it down when leaving so its listeners don't fight the tracked/character/
    // sculpt input in the other modes.
    if (this._controls) this._controls.enabled = false
    if (m === 'orbit') this._ensureSharedControls()
    else this._teardownSharedControls()
    if (this._container) this._container.style.pointerEvents = 'auto'
    document.body.classList.toggle('cfg-3d-active', this._visible)
    if (this._orbitCamera) {
      this._orbitCamera.fov = m === 'firstperson' ? 78 : 50
      this._orbitCamera.updateProjectionMatrix()
      // Top-down repoints camera.up to a horizontal axis for its straight-down shot;
      // restore world-up before OrbitControls (orbit) or the FP look-math take over,
      // or their orbits/tilts rotate around the wrong axis.
      if (m !== 'tracked') this._orbitCamera.up.set(0, 1, 0)
    }
    this._setFpInput(this._visible) // keyboard + wheel + 3D-pick mouse for every 3D mode
    if (m === 'orbit') this.setView('default')
    else if (m === 'firstperson') {
      // Clear stale movement on every (re-)entry — switching 3D modes doesn't re-run
      // _setFpInput (its handlers are already bound), so a leftover glide goal or a
      // held key would otherwise replay a turn late. Re-anchor to the token's position.
      this._fpGoal = null
      this._keys = { fwd: false, back: false, left: false, right: false }
      this._fpCenter = null
      this._subjectElev = undefined
      this._fpStep(typeof performance !== 'undefined' ? performance.now() : 0)
    } else this._syncTrackedCamera() // TRUE top-down (directly overhead)
    this._render()
  }

  /**
   * Switch camera mode: 'tracked' (top-down, follows Foundry — UI aligns over
   * the 3D) or 'orbit' (free-look perspective — UI hidden).
   */
  setMode(mode) {
    mode = ['tracked', 'orbit', 'firstperson'].includes(mode) ? mode : 'tracked'
    if (mode === this._mode) return
    this._mode = mode
    if (this._mounted && this._visible) {
      this._applyMode()
      this.rebuild() // floor/bg/grid differ per mode (tracked = Foundry's canvas)
    }
    this._updateControlBar()
    this._syncControlState() // reflect the mode toggle in the 3D control group
  }

  /**
   * The user-facing view mode: '2d' (overlay off, normal Foundry), 'topdown'
   * (mirrors Foundry), 'free' (orbit camera), or 'firstperson' (camera at the
   * controlled token — Character view: 3rd/1st person, WASD move, mouse aims, wheel zooms).
   */
  async setViewMode(mode) {
    if (mode === 'free' && !this._canBuild()) {
      // Defence-in-depth: the toolbar hides Free Camera from players, but a macro/API
      // call must not slip past the gate.
      ui?.notifications?.warn?.('Free Camera is available to GMs and Assistant GMs only.')
      return
    }
    if (mode === '2d') {
      await this.setVisible(false)
      this._updateControlBar()
      this._syncControlState()
      return
    }
    const cam = mode === 'topdown' ? 'tracked' : mode === 'firstperson' ? 'firstperson' : 'orbit'
    if (cam === 'firstperson') {
      // Pin the character-view subject = the controlled token, and re-anchor the FP camera
      // to it. This is the ONLY place the subject changes (Token-HUD "3D View" button).
      const subj = canvas?.tokens?.controlled?.[0]?.id || this._lastTokenId || this._fpSubjectId
      if (subj) this._fpSubjectId = subj
      this._fpCenter = null
      this._fpGoal = null
      this._subjectElev = undefined
    }
    if (!this._visible) {
      this._mode = cam
      await this.setVisible(true)
    } else {
      this.setMode(cam)
    }
    this._updateControlBar()
    this._syncControlState()
  }

  /** The current user-facing view mode (for the menu + hint). */
  _currentViewMode() {
    if (!this._visible) return '2d'
    if (this._mode === 'tracked') return 'topdown'
    if (this._mode === 'firstperson') return 'firstperson'
    return 'free'
  }

  /**
   * Toggle the floor-slice cutaway: when on, only the active floor (a selected
   * token's level, else Foundry's viewed level) and the floors below it render —
   * floors above are hidden so their walls/ceilings don't block the view.
   */
  setSlice(on) {
    this._sliceFloors = !!on
    if (this._mounted && this._visible) this.rebuild()
    this._updateControlBar()
    this._syncControlState() // reflect the slice toggle in the 3D control group
  }

  /**
   * A slim, non-interactive on-screen hint showing the mouse-camera controls in
   * orbit mode — the one thing a toolbar can't convey (drag to rotate/tilt). All
   * the buttons live in the top-level "3D View" scene-control group now.
   */
  _buildControlBar() {
    if (!this._container || this._controlBar) return
    const bar = document.createElement('div')
    bar.id = 'cfg-3d-controls'
    Object.assign(bar.style, {
      position: 'fixed',
      top: '6px',
      left: '50%',
      transform: 'translateX(-50%)',
      padding: '5px 10px',
      background: 'rgba(11,14,19,0.7)',
      border: '1px solid rgba(255,255,255,0.1)',
      borderRadius: '8px',
      font: '12px/1 system-ui, sans-serif',
      color: '#cdd3da',
      pointerEvents: 'none', // non-interactive hint — controls are in the 3D scene-control group
      userSelect: 'none',
      opacity: '0.7',
    })
    bar.textContent = 'drag rotate · scroll zoom · right-drag pan'
    this._container.appendChild(bar)
    this._controlBar = bar
    this._updateControlBar()
  }

  /** Show a per-mode controls hint (orbit: mouse; first-person: WASD). */
  _updateControlBar() {
    if (!this._controlBar) return
    const m = this._mode
    this._controlBar.style.display = this._visible ? '' : 'none'
    this._controlBar.textContent =
      m === 'firstperson'
        ? 'WASD move · right-drag look · left-drag target box · Q/E up-down · scroll zoom'
        : m === 'tracked'
          ? 'arrows pan · scroll zoom · click select/target'
          : 'left-click select · right-drag orbit · WASD/arrows move · Q/E up-down · scroll zoom'
  }

  /** Full-screen "Loading 3D view…" overlay while the three.js bundle + first scene build
   * run, so entering 3D never looks like a hung tab. */
  _showLoading() {
    let el = this._loadingEl
    if (!el) {
      el = document.createElement('div')
      el.id = 'cfg-3d-loading'
      Object.assign(el.style, {
        position: 'fixed', inset: '0', zIndex: '27', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: '12px', background: 'rgba(11,14,19,0.82)',
        color: '#cdd6e0', font: '500 15px system-ui, sans-serif',
      })
      el.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="font-size:26px"></i><div>Loading 3D view…</div>'
      document.body.appendChild(el)
      this._loadingEl = el
    }
    el.style.display = 'flex'
  }

  _hideLoading() {
    if (this._loadingEl) this._loadingEl.style.display = 'none'
  }

  /** Bottom-right compass. The rose rotates so N always points to world-north on screen
   * (default = north-up). Top-Down is locked north-up; Free/Character track the camera. */
  _buildCompass() {
    if (this._compass || !this._container) return
    const wrap = document.createElement('div')
    wrap.id = 'cfg-3d-compass'
    // Bottom-LEFT, just above the players (username/latency) pill so it clears the chat.
    Object.assign(wrap.style, { position: 'fixed', left: '12px', bottom: '96px', width: '58px', height: '58px', zIndex: '26', pointerEvents: 'none' })
    const rose = document.createElement('div')
    Object.assign(rose.style, {
      width: '100%', height: '100%', borderRadius: '50%', position: 'relative',
      background: 'rgba(10,14,19,0.66)', border: '1px solid rgba(255,255,255,0.28)',
      boxShadow: '0 1px 6px rgba(0,0,0,0.4)', transition: 'transform 0.08s linear',
      font: '600 10px system-ui, sans-serif', color: '#cdd6e0',
    })
    rose.innerHTML =
      '<div style="position:absolute;top:1px;left:50%;transform:translateX(-50%);width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:12px solid #ff5b5b"></div>' +
      '<div style="position:absolute;top:13px;left:50%;transform:translateX(-50%);color:#ff7b7b;font-weight:700">N</div>' +
      '<div style="position:absolute;bottom:2px;left:50%;transform:translateX(-50%)">S</div>' +
      '<div style="position:absolute;left:4px;top:50%;transform:translateY(-50%)">W</div>' +
      '<div style="position:absolute;right:4px;top:50%;transform:translateY(-50%)">E</div>'
    wrap.appendChild(rose)
    this._container.appendChild(wrap)
    this._compass = wrap
    this._compassRose = rose
    this._positionCompass()
  }

  /** Sit the compass at bottom-left, just above the Foundry players (username/latency)
   * pill so it never overlaps the chat. Falls back to a fixed bottom-left offset. */
  _positionCompass() {
    if (!this._compass) return
    this._compass.style.right = 'auto'
    const r = document.querySelector('#players')?.getBoundingClientRect?.()
    if (r && r.height > 0) {
      this._compass.style.left = `${Math.max(12, Math.round(r.left))}px`
      this._compass.style.bottom = `${Math.round(window.innerHeight - r.top + 8)}px`
    } else {
      this._compass.style.left = '12px'
      this._compass.style.bottom = '96px'
    }
  }

  _updateCompass() {
    if (!this._compassRose || !this._orbitCamera) return
    const now = typeof performance !== 'undefined' ? performance.now() : 0
    if (now - (this._compassPosAt || 0) > 800) {
      this._positionCompass() // re-anchor if the players pill grew/collapsed (throttled)
      this._compassPosAt = now
    }
    let deg = 0
    if (this._mode !== 'tracked') {
      const fwd = this._tmpFwd || (this._tmpFwd = new this._THREE.Vector3())
      this._orbitCamera.getWorldDirection(fwd)
      // heading 0 = looking north (-Z); rotate the rose the opposite way so N stays north.
      if (Math.abs(fwd.x) > 1e-4 || Math.abs(fwd.z) > 1e-4) deg = (-Math.atan2(fwd.x, -fwd.z) * 180) / Math.PI
    }
    this._compassRose.style.transform = `rotate(${deg.toFixed(1)}deg)`
  }

  /** May this token move right now? GMs (refs) always can. Otherwise: not while the game
   * is paused, and not when the token is in the active combat but it isn't its turn. */
  _movementAllowed(tok) {
    if (this._isGM()) return true
    if (game?.paused) return false
    const combat = game?.combat
    if (combat?.started) {
      const isCombatant = combat.combatants?.some?.((c) => c.tokenId === tok?.id)
      const isMyTurn = combat.combatant?.tokenId === tok?.id
      if (isCombatant && !isMyTurn) return false
    }
    return true
  }

  /** Throttled "why can't I move" notice. */
  _notifyMovementBlocked() {
    const now = typeof performance !== 'undefined' ? performance.now() : 0
    if (now - (this._moveBlockNotifyAt || 0) < 2500) return
    this._moveBlockNotifyAt = now
    ui?.notifications?.warn?.(game?.paused ? 'Game is paused — movement is locked.' : "Not your turn — you can't move yet.")
  }

  /** Screen point → the ground point in CANVAS coords (world x,z map to canvas x,y).
   * Uses the y=0 plane; in Top-Down (straight down) that's exact. */
  _pickGround(clientX, clientY) {
    const cam = this._orbitCamera
    const dom = this._renderer?.domElement
    if (!cam || !dom) return null
    const THREE = this._THREE
    const r = dom.getBoundingClientRect()
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1)
    const ray = new THREE.Raycaster()
    ray.setFromCamera(ndc, cam)
    const hit = new THREE.Vector3()
    if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) return null
    return { x: hit.x, y: hit.z }
  }

  /** Top-Down: move the controlled token to a ground destination (grid-snapped, wall +
   * turn checked). Foundry's own movement pipeline animates + measures it; we show the
   * distance in 3D via the move ruler. */
  _moveControlledTo(dest) {
    if (!dest) return
    const tok = canvas?.tokens?.controlled?.[0]
    if (!tok?.document) return
    if (!this._movementAllowed(tok)) return this._notifyMovementBlocked()
    const origin = tok.center
    const center = this._snapToGrid(dest, tok) // footprint-aware: grid-aligns any token size (even 2x2/4x4), free on gridless
    if (this._moveBlocked(origin, center)) return void ui?.notifications?.warn?.('Blocked by a wall.')
    this._moveOrigin = { x: origin.x, y: origin.y }
    this._moveTokenId = tok.id // bind the ruler to this token so a later selection doesn't hijack it
    this._moveLastAt = typeof performance !== 'undefined' ? performance.now() : 0
    const { w, h } = this._tokenSizePx(tok.document)
    tok.document.update({ x: Math.round(center.x - w / 2), y: Math.round(center.y - h / 2) })
  }

  /** Live movement ruler: a 3D path from where the current movement started to the
   * moving token, plus the Foundry-measured distance. Shows while moving, clears when
   * idle for a beat. */
  _updateMoveRuler() {
    const now = typeof performance !== 'undefined' ? performance.now() : 0
    // The ruler tracks the token that STARTED this move (_moveTokenId): its smooth _fpCenter
    // while it's the active first-person mover, else its committed centre. Once it stops
    // moving (e.g. selection switched away) the idle timeout below clears it.
    const movingTok = this._moveTokenId ? canvas?.tokens?.get?.(this._moveTokenId) : null
    const cur = movingTok
      ? this._mode === 'firstperson' && movingTok.id === this._fpMoverId && this._fpCenter
        ? this._fpCenter
        : movingTok.center
      : null
    if (this._moveOrigin && cur) {
      const lp = this._moveLastPos // any real motion (incl. a still-animating Top-Down move) keeps the ruler alive
      if (!lp || Math.hypot(cur.x - lp.x, cur.y - lp.y) > 0.5) {
        this._moveLastAt = now
        this._moveLastPos = { x: cur.x, y: cur.y }
      }
    }
    if (!this._moveOrigin || !cur || now - (this._moveLastAt || 0) > 1200) return this._clearMoveRuler()
    const THREE = this._THREE
    const o = this._moveOrigin
    if (!this._moveLine) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3))
      this._moveLine = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffd447, transparent: true, opacity: 0.95, depthTest: false }))
      this._moveLine.renderOrder = 900
      this._viewer?.scene?.add(this._moveLine)
    }
    const p = this._moveLine.geometry.attributes.position
    p.setXYZ(0, o.x, 3, o.y)
    p.setXYZ(1, cur.x, 3, cur.y)
    p.needsUpdate = true
    let dist
    try {
      dist = canvas.grid.measurePath([{ x: o.x, y: o.y }, { x: cur.x, y: cur.y }]).distance
    } catch {
      const size = canvas?.dimensions?.size || 100
      dist = (Math.hypot(cur.x - o.x, cur.y - o.y) / size) * (canvas?.dimensions?.distance || 5)
    }
    this._showMoveLabel(`${Math.round(dist)} ${canvas?.scene?.grid?.units || ''}`.trim(), cur)
  }

  _showMoveLabel(text, canvasPos) {
    let el = this._moveLabel
    if (!el) {
      el = document.createElement('div')
      Object.assign(el.style, {
        position: 'fixed', zIndex: '28', pointerEvents: 'none', padding: '2px 8px', borderRadius: '10px',
        background: 'rgba(20,24,30,0.85)', color: '#ffd447', font: '600 13px system-ui, sans-serif',
        transform: 'translate(-50%,-150%)', whiteSpace: 'nowrap',
      })
      document.body.appendChild(el)
      this._moveLabel = el
    }
    el.textContent = text
    el.style.display = 'block'
    const wp = (this._tmpLabel || (this._tmpLabel = new this._THREE.Vector3()))
    wp.set(canvasPos.x, 40, canvasPos.y).project(this._orbitCamera)
    el.style.left = `${Math.round((wp.x * 0.5 + 0.5) * window.innerWidth)}px`
    el.style.top = `${Math.round((-wp.y * 0.5 + 0.5) * window.innerHeight)}px`
  }

  _clearMoveRuler() {
    this._moveOrigin = null
    this._moveTokenId = null
    this._moveLastPos = null
    if (this._moveLine) {
      this._viewer?.scene?.remove(this._moveLine)
      this._moveLine.geometry.dispose()
      this._moveLine.material.dispose()
      this._moveLine = null
    }
    if (this._moveLabel) this._moveLabel.style.display = 'none'
  }

  /**
   * Foundry-style animated corner brackets around every CONTROLLED (selected) token — the 3D
   * analogue of Foundry's 2D selection indicator, which reads far more clearly than the base
   * ring in Character view. A DOM overlay (like Foundry's own HUD) so it matches the native
   * look and always faces the screen. Box = the token's screen-space footprint + mini height.
   */
  _updateSelectionBrackets() {
    const cam = this._orbitCamera
    const THREE = this._THREE
    if (!cam || !THREE || !this._viewer?.tokens) return
    let cont = this._selEl
    if (!cont) {
      cont = document.createElement('div')
      cont.id = 'cfg-3d-select'
      Object.assign(cont.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '27' })
      document.body.appendChild(cont)
      this._selEl = cont
      this._selMap = new Map()
      this._injectSelectStyle()
    }
    const controlled = canvas?.tokens?.controlled || []
    const color = this._controlColorCss()
    cam.updateMatrixWorld()
    const w = window.innerWidth || 1
    const h = window.innerHeight || 1
    const size = canvas?.dimensions?.size || 100
    const v = new THREE.Vector3()
    const e = new THREE.Vector3()
    const seen = new Set()
    for (const tok of controlled) {
      const g = this._viewer.tokens.get?.(tok.id)
      if (!g?.visible || !tok?.document) continue // skip a hidden mini (e.g. your own body in 1st person)
      g.getWorldPosition(v)
      const base = v.clone().project(cam)
      if (base.z > 1) continue // behind the camera
      const bx = (base.x * 0.5 + 0.5) * w
      const by = (-base.y * 0.5 + 0.5) * h
      const rWorld = Math.max(tok.document.width || 1, tok.document.height || 1) * size * 0.5
      e.set(v.x + rWorld, v.y, v.z).project(cam)
      const rS = Math.max(10, Math.hypot((e.x * 0.5 + 0.5) * w - bx, (-e.y * 0.5 + 0.5) * h - by))
      e.set(v.x, v.y + size * 1.8, v.z).project(cam) // top of the billboarded mini
      const ty = (-e.y * 0.5 + 0.5) * h
      const minX = bx - rS * 1.05
      const maxX = bx + rS * 1.05
      const minY = Math.min(ty, by - rS)
      const maxY = by + rS * 0.4
      seen.add(tok.id)
      let el = this._selMap.get(tok.id)
      if (!el) {
        el = document.createElement('div')
        el.className = 'cfg-3d-bracket'
        el.innerHTML = '<i class="c tl"></i><i class="c tr"></i><i class="c bl"></i><i class="c br"></i>'
        cont.appendChild(el)
        this._selMap.set(tok.id, el)
      }
      el.style.left = `${Math.round(minX)}px`
      el.style.top = `${Math.round(minY)}px`
      el.style.width = `${Math.round(maxX - minX)}px`
      el.style.height = `${Math.round(maxY - minY)}px`
      el.style.setProperty('--cfg-sel', color)
    }
    for (const [id, el] of this._selMap) {
      if (!seen.has(id)) {
        el.remove()
        this._selMap.delete(id)
      }
    }
  }

  /** Foundry's canonical control color (gold) for the selection brackets; falls back if the
   * config isn't populated. */
  _controlColorCss() {
    const c = globalThis.CONFIG?.Canvas?.dispositionColors?.CONTROLLED
    if (typeof c === 'number') return `#${(c >>> 0).toString(16).padStart(6, '0').slice(-6)}`
    return '#ff9829'
  }

  _injectSelectStyle() {
    if (document.getElementById('cfg-3d-select-style')) return
    const s = document.createElement('style')
    s.id = 'cfg-3d-select-style'
    s.textContent =
      '.cfg-3d-bracket{position:absolute;pointer-events:none;animation:cfg-sel-pulse 1.1s ease-in-out infinite}' +
      '.cfg-3d-bracket .c{position:absolute;width:16px;height:16px;box-sizing:border-box;filter:drop-shadow(0 0 2px rgba(0,0,0,0.7))}' +
      '.cfg-3d-bracket .c.tl{top:-2px;left:-2px;border-top:3px solid var(--cfg-sel);border-left:3px solid var(--cfg-sel)}' +
      '.cfg-3d-bracket .c.tr{top:-2px;right:-2px;border-top:3px solid var(--cfg-sel);border-right:3px solid var(--cfg-sel)}' +
      '.cfg-3d-bracket .c.bl{bottom:-2px;left:-2px;border-bottom:3px solid var(--cfg-sel);border-left:3px solid var(--cfg-sel)}' +
      '.cfg-3d-bracket .c.br{bottom:-2px;right:-2px;border-bottom:3px solid var(--cfg-sel);border-right:3px solid var(--cfg-sel)}' +
      '@keyframes cfg-sel-pulse{0%,100%{opacity:1}50%{opacity:0.5}}'
    document.head.appendChild(s)
  }

  _clearSelectionBrackets() {
    if (this._selMap) {
      for (const [, el] of this._selMap) el.remove()
      this._selMap.clear()
    }
  }

  /** Bare right-click in Character view → the token's HUD menu, re-shown over the 3D view
   * (the canvas HUD is hidden by cfg-3d-active) and positioned over the token's 3D screen
   * position. Dismissed on the next scene click (see _onCharDown) or when 3D closes. */
  _showTokenHud(event) {
    const tok = this._pick(event.clientX, event.clientY) || this._pickNearest(event.clientX, event.clientY)
    if (!tok) return
    event.preventDefault?.()
    event.stopImmediatePropagation?.()
    try {
      document.body.classList.add('cfg-3d-show-hud')
      canvas.hud.token.bind(tok)
      canvas.hud.token.render(true)
      this._hudShown = true
      const grp = this._viewer?.tokens?.get(tok.id)
      const el = canvas.hud.token.element
      if (grp && el && this._orbitCamera) {
        const wp = (this._tmpHud || (this._tmpHud = new this._THREE.Vector3()))
        grp.getWorldPosition(wp)
        wp.y += 30
        const p = wp.project(this._orbitCamera)
        const x = (p.x * 0.5 + 0.5) * window.innerWidth
        const y = (-p.y * 0.5 + 0.5) * window.innerHeight
        requestAnimationFrame(() => {
          Object.assign(el.style, { position: 'fixed', left: `${Math.round(x)}px`, top: `${Math.round(y)}px`, transform: 'translate(-50%,-50%)', zIndex: '31' })
        })
      }
    } catch {
      /* ignore */
    }
  }

  _hideTokenHud() {
    if (!this._hudShown) return
    this._hudShown = false
    document.body.classList.remove('cfg-3d-show-hud')
    try {
      const el = canvas?.hud?.token?.element
      if (el) Object.assign(el.style, { position: '', left: '', top: '', transform: '', zIndex: '' })
      canvas?.hud?.token?.clear?.()
    } catch {
      /* ignore */
    }
  }

  /**
   * Native v14 `Level` map images as floor planes at each level's elevation, as
   * viewer-core `levels[]` entries (a textured quad per background/foreground).
   * In v14 a Scene's map is decomposed into embedded Level documents — the base
   * map is the first level, and stacked floors are further levels at higher
   * elevations. Each level's `background` (at elevation.bottom) and optional
   * `foreground` roof (at elevation.top) becomes a scene-rect-sized quad.
   *
   * Transparency comes from the image's OWN alpha channel via the core's
   * `alphaTest` (a hard cutout, seeded from the level's `alphaThreshold`) — so a
   * holed upper floor reveals the floor below it, without the depth-sort/z-fight
   * problems `transparent` blending brings to stacked coplanar floors. (Foundry's
   * own `alphaThreshold` actually drives a CPU hit-test + a separate surface-
   * occlusion shader; we approximate the visible result via the texture alpha.)
   *
   * Falls back to the scene's plain background image as a single ground-level
   * quad when there are no Level docs at all (legacy/degenerate scene) — an
   * empty return lets the core's flat-color ground apply (blank-slate boot).
   */
  _buildLevelsJson() {
    const scene = canvas?.scene
    const levels = scene?.levels?.contents ?? (Array.isArray(scene?.levels) ? scene.levels : [])
    return buildLevelsJson(levels, {
      levelElevPx: (level, which) => this._levelElevPx(level, which),
      assetUrl: (src) => this._assetUrl(src),
      sliceCut: () => this._sliceCut(),
      levelBase: (level) => this._levelBase(level),
      activeLevel: () => this._activeLevel(),
      userCanSeeLevel: (level) => this._userCanSeeLevel(level),
      backgroundSrc: () => this._backgroundSrc(),
      firstPerson: this._isTrueFirstPerson(),
      levelVisibleFromActive: (level) => this._levelVisibleFromActive(level),
    })
  }

  /**
   * Native Foundry Regions → viewer terrain (flat-topped tiers). OPT-IN: a region renders
   * as terrain only when it carries `flags['crit-fumble-core'].terrain === true` (so native
   * scenes and non-terrain regions — lighting/darkness zones — are untouched). The standable
   * SURFACE height defaults to the region's own `elevation.bottom` (native-first), overridable
   * by an optional `surface` flag; the skirt drops to an optional `base` flag (else 0 = sea
   * level). Geometry comes straight from Foundry's resolved `triangulation` + `polygonTree`.
   */
  _buildRegionsJson() {
    const scene = canvas?.scene
    const regions = scene?.regions?.contents ?? (Array.isArray(scene?.regions) ? scene.regions : [])
    if (!regions.length) return []
    const bg = this._backgroundSrc()
    const mapUrl = bg ? this._assetUrl(bg) : undefined // draped over raised tops = the lifted map content
    const resolved = []
    for (const doc of regions) {
      try {
        if (!doc || doc.hidden) continue
        const cfg = doc.flags?.['crit-fumble-core'] || {}
        if (cfg.terrain !== true) continue // opt-in only
        const surface = Number.isFinite(Number(cfg.surface))
          ? Number(cfg.surface)
          : Number.isFinite(doc.elevation?.bottom)
            ? Number(doc.elevation.bottom)
            : 0
        const tri = doc.triangulation || doc.polygonTree?.triangulation
        if (!tri?.vertices?.length || !tri?.indices?.length) continue
        // Base (skirt bottom): explicit flag wins; else sit the tier on the heightmap surface
        // beneath it (a cliff/mesa rises vertically from the ground), else sea level (0).
        let base
        if (Number.isFinite(Number(cfg.base))) base = Number(cfg.base)
        else {
          const c = this._regionCentroid(doc)
          const t = c ? this._sampleTerrain(c.x, c.y) : null
          base = t != null ? t : 0
        }
        resolved.push({
          id: doc.id,
          surface,
          base,
          vertices: Array.from(tri.vertices),
          indices: Array.from(tri.indices),
          rings: this._regionRings(doc),
          // Default: drape the scene map over the raised top (lifted island content). An
          // explicit colour flag overrides to a flat-coloured tier instead.
          src: cfg.color ? undefined : mapUrl,
          color: parseHexColor(cfg.color, null) ?? (Number.isFinite(Number(doc.color)) ? Number(doc.color) : undefined),
        })
      } catch {
        /* skip a malformed region */
      }
    }
    return buildRegionsJson(resolved, { pxPerUnit: this._pxPerUnit() })
  }

  /**
   * Continuous heightmap terrain from the OPTIONAL scene flag
   * `flags['crit-fumble-core'].heightfield = { cols, rows, heights (grid units, row-major) }`.
   * Absent → null (the core keeps its flat map floor; native scenes are untouched). The map
   * texture drapes over the displaced surface.
   */
  _buildTerrainJson() {
    const field = canvas?.scene?.flags?.['crit-fumble-core']?.heightfield
    if (!field) return null
    const bg = this._backgroundSrc()
    return buildTerrainJson(field, {
      pxPerUnit: this._pxPerUnit(),
      src: bg ? this._assetUrl(bg) : undefined,
    })
  }

  /**
   * Bilinear height (grid units) of the terrain field at scene-canvas (x, y), or null when
   * there is no field. Lets tokens/other placeables sit ON the terrain instead of the flat
   * floor. The field spans the scene rect (canvas dimensions.sceneRect).
   */
  _sampleTerrain(x, y) {
    const field = canvas?.scene?.flags?.['crit-fumble-core']?.heightfield
    const cols = Math.floor(Number(field?.cols))
    const rows = Math.floor(Number(field?.rows))
    const data = field?.heights
    if (!(cols >= 2) || !(rows >= 2) || !Array.isArray(data) || data.length < cols * rows) return null
    const rect = canvas?.dimensions?.sceneRect || { x: 0, y: 0, width: canvas?.dimensions?.width || 1, height: canvas?.dimensions?.height || 1 }
    const u = Math.min(1, Math.max(0, (x - rect.x) / rect.width)) * (cols - 1)
    const v = Math.min(1, Math.max(0, (y - rect.y) / rect.height)) * (rows - 1)
    const i0 = Math.floor(u)
    const j0 = Math.floor(v)
    const i1 = Math.min(cols - 1, i0 + 1)
    const j1 = Math.min(rows - 1, j0 + 1)
    const fx = u - i0
    const fy = v - j0
    const at = (i, j) => Number(data[j * cols + i]) || 0
    const top = at(i0, j0) * (1 - fx) + at(i1, j0) * fx
    const bot = at(i0, j1) * (1 - fx) + at(i1, j1) * fx
    return top * (1 - fy) + bot * fy
  }

  /** Approximate centroid (canvas px) of a region — the mean of its first outer ring's
   * points — used to sample the terrain height the tier sits on. */
  _regionCentroid(doc) {
    const pts = doc?.polygonTree?.children?.[0]?.points
    if (!pts || pts.length < 6) return null
    let sx = 0
    let sy = 0
    const n = Math.floor(pts.length / 2)
    for (let i = 0; i < n; i++) {
      sx += pts[i * 2]
      sy += pts[i * 2 + 1]
    }
    return { x: sx / n, y: sy / n }
  }

  /** Boundary loops (outer rings + holes) from Foundry's resolved polygon tree, flat
   * [x,y,…] canvas px — the vertical skirt walls. */
  _regionRings(doc) {
    const rings = []
    const walk = (node) => {
      for (const child of node?.children || []) {
        const pts = child.points
        if (pts && pts.length >= 6) rings.push(Array.from(pts))
        walk(child) // a hole (child of an outer ring) gets its own skirt too
      }
    }
    walk(doc?.polygonTree)
    return rings
  }

  /**
   * TRUE first-person: the character-view camera zoomed all the way in to eye height
   * (`_charDist` below half a grid — the same split the camera + subject-model visibility
   * use). The pulled-back third-person sub-state (the DEFAULT on entry) is NOT true FP and
   * keeps the top-down-style cutaway. Only true FP gets the enclosed lens: own ceiling, and
   * only the character's floor + authored visible-through floors.
   */
  _isTrueFirstPerson() {
    return this._mode === 'firstperson' && this._charDist < (canvas?.dimensions?.size || 100) * 0.5
  }

  /**
   * Re-slice once when the camera crosses the eye-height threshold, since the enclosed
   * lens (own ceiling + only visible-through floors) is baked at scene-build time. Only
   * rebuilds on an actual state change, and only when the scene has levels (else the lens
   * is a no-op). Lazily baselines so the first zoom after entering FP doesn't churn.
   */
  _maybeResliceOnFpZoom() {
    const now = this._isTrueFirstPerson()
    if (this._wasTrueFp === undefined) {
      this._wasTrueFp = now
      return
    }
    if (now !== this._wasTrueFp) {
      this._wasTrueFp = now
      if ((canvas?.scene?.levels?.size || 0) > 0) this._scheduleRebuild()
    }
  }

  /**
   * Whether a level is visible from the active one via Foundry's authored inter-level
   * visibility (Level.visibility.levels — the `isVisible` mirror). The active level always
   * sees itself. Consulted only in true first-person (openings looked through).
   */
  _levelVisibleFromActive(level) {
    const active = this._activeLevel()
    if (!active || active === level) return true
    const set = active.visibility?.levels
    return !!(set && typeof set.has === 'function' && set.has(level.id))
  }

  /**
   * True-first-person doc visibility: a placeable shows when its floor is the active level
   * or an authored visible-through floor AND the player may see that floor (availableLevels).
   * Keeps walls/tiles/lights/tokens consistent with the level planes buildLevelsJson draws —
   * so a floor whose plane is hidden never leaks its geometry. Empty per-doc levels-set = all floors.
   */
  _docOnVisibleLevel(doc) {
    const active = this._activeLevel()
    if (!active) return true
    const lvls = canvas?.scene?.levels
    const visible = (id) => {
      const lvl = id && lvls?.get?.(id)
      if (!lvl) return id === active.id
      if (!this._userCanSeeLevel(lvl)) return false // player availableLevels gate — matches the plane gate
      return lvl.id === active.id || this._levelVisibleFromActive(lvl)
    }
    const set = doc?.levels
    if (set !== undefined) {
      const ids = set && typeof set[Symbol.iterator] === 'function' ? [...set] : []
      if (!ids.length) return true // all-floors doc
      return ids.some(visible)
    }
    if (doc?.level !== undefined) return visible(doc.level)
    return true
  }

  /**
   * A level's elevation in pixels for the given edge ('bottom' for a background,
   * 'top' for a foreground). Honors the null→±Infinity open-band contract by
   * falling back to the client-derived finite `elevation.base` (never ±Infinity).
   */
  _levelElevPx(level, which) {
    const e = level?.elevation || {}
    let v = which === 'top' ? e.top : e.bottom
    if (!Number.isFinite(Number(v))) v = Number(e.base)
    if (!Number.isFinite(v)) v = 0
    return v * this._pxPerUnit()
  }

  /**
   * Resolve a Foundry asset path (stored relative by FilePathField, e.g.
   * "modules/.../floor.png") to an absolute URL three.js's loaders can fetch.
   * Honors Foundry's route prefix via getRoute; passes absolute/data/blob through.
   */
  _assetUrl(src) {
    if (!src || /^(https?:|data:|blob:)/i.test(src)) return src
    try {
      const route = typeof foundry?.utils?.getRoute === 'function' ? foundry.utils.getRoute(src) : src
      return new URL(route, window.location.origin).href
    } catch {
      try {
        return new URL(src, document.baseURI).href
      } catch {
        return src
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Floor slice — render the active Level + the floors below it, hide  */
  /*  the floors above so upper walls/floors don't block the view (the   */
  /*  TaleSpire "current floor" cutaway). The active floor follows a      */
  /*  selected token (focus), else Foundry's viewed level (canvas.level). */
  /* ------------------------------------------------------------------ */

  /** A Level's finite base elevation in grid units (0 if unknown/open). */
  _levelBase(level) {
    return levelBase(level) // pure, unit-tested; open (null) bottom = min(top,0) per the v14 schema
  }

  /** Base elevation of a level by id (0 if unknown). */
  _levelBaseOf(levelId) {
    if (!levelId) return 0
    const lvl = canvas?.scene?.levels?.get?.(levelId)
    return lvl ? this._levelBase(lvl) : 0
  }

  /** A Level's top elevation in grid units; +Infinity for an open (null) top. */
  _levelTop(level) {
    return levelTop(level)
  }

  /** Default wall height in grid-distance units (~2 grid squares) when unknown. */
  _defaultWallUnits() {
    const d = canvas?.dimensions
    return d?.distance ? Number(d.distance) * 2 : 10
  }

  /**
   * A wall's vertical band [bottom, top] in grid units (worldspace elevation).
   * Priority: the community wall-height flag (absolute), else the native v14
   * Level band(s) the wall belongs to — so a wall sits at its floor's height in
   * worldspace, not at the ground — else a sensible default. An empty levels-set
   * means "all floors", so the wall spans the whole building.
   */
  _wallBand(doc) {
    const wh = doc?.flags?.['wall-height'] || {}
    const hasFlag = Number.isFinite(wh.bottom) || Number.isFinite(wh.top)
    const defUnits = this._defaultWallUnits()
    if (hasFlag) {
      const bottom = Number.isFinite(wh.bottom) ? Number(wh.bottom) : 0
      const top = Number.isFinite(wh.top) ? Number(wh.top) : bottom + defUnits
      return { bottom, top }
    }
    const lvls = canvas?.scene?.levels
    const ids = doc?.levels && typeof doc.levels[Symbol.iterator] === 'function' ? [...doc.levels] : []
    const pool = (ids.length ? ids.map((id) => lvls?.get?.(id)) : lvls?.contents || []).filter(Boolean)
    if (pool.length) {
      let bottom = Infinity
      let top = -Infinity
      for (const l of pool) {
        bottom = Math.min(bottom, this._levelBase(l))
        top = Math.max(top, this._levelTop(l))
      }
      if (!Number.isFinite(bottom)) bottom = 0
      if (!Number.isFinite(top)) top = bottom + defUnits
      return { bottom, top }
    }
    return { bottom: 0, top: defUnits }
  }

  /**
   * The active "viewed" floor for the slice: a selected token's level (focus)
   * takes priority, then Foundry's currently-viewed level (canvas.level), then
   * the topmost level. Null when the scene has no levels.
   */
  _activeLevel() {
    const scene = canvas?.scene
    const lvls = scene?.levels
    if (!lvls || !lvls.size) return null
    // Delegate the precedence to the pure resolver. In firstperson (character) view the
    // SUBJECT's floor wins outright — regardless of the off-by-default focus-follow toggle
    // or where the GM navigated (canvas.level) — because the camera is anchored on the
    // character. Every other mode reproduces the legacy chain exactly.
    return resolveActiveLevel({
      mode: this._mode,
      get: (id) => (id && lvls.get?.(id)) || null,
      firstPersonLevelId: this._firstPersonLevelId(),
      focusFollow: this._focusFollowEnabled(),
      focusLevelId: canvas?.tokens?.controlled?.[0]?.document?.level,
      canvasLevel: canvas?.level || null,
      viewLevelId: scene._view,
      allLevels: lvls.contents || [],
      levelBase: (l) => this._levelBase(l),
    })
  }

  /**
   * The floor the first-person SUBJECT is on, for slicing the view. Derived from the
   * character's ELEVATION first (so moving up/down with Q/E re-slices — elevation drives
   * vision), falling back to the token's authored `level` membership. Undefined when there
   * is no subject, so _activeLevel then falls through to the legacy chain.
   */
  _firstPersonLevelId() {
    const doc = this._firstPersonToken()?.document
    if (!doc) return undefined
    const lvls = canvas?.scene?.levels
    const byElev =
      lvls && lvls.size
        ? levelContainingElevation(lvls.contents || [], Number(doc.elevation), (l) => this._levelBase(l), (l) => this._levelTop(l))
        : null
    return byElev?.id ?? doc.level ?? undefined
  }

  /**
   * The slice cutoff elevation: floors whose base is above this are hidden.
   * +Infinity when the slice is off or the scene has no levels (→ render all).
   */
  _sliceCut() {
    if (this._sliceFloors === false) return Infinity
    const a = this._activeLevel()
    return a ? this._levelBase(a) : Infinity
  }

  /**
   * Whether a placeable document is within the current floor-slice (its floor is
   * the active level or below). A token carries a single `level`; walls / tiles /
   * lights / notes carry a `levels` Set (empty = all floors → always shown).
   */
  _docInSlice(doc) {
    // True first-person: enclosed lens — only the character's floor + authored visible-through
    // floors (kept consistent with the level planes). Other modes use the top-down cutaway.
    if (this._isTrueFirstPerson()) return this._docOnVisibleLevel(doc)
    const cut = this._sliceCut()
    if (!Number.isFinite(cut)) return true
    const set = doc?.levels
    if (set !== undefined) {
      const ids = set && typeof set[Symbol.iterator] === 'function' ? [...set] : []
      if (!ids.length) return true // empty levels-set = present on every floor
      return ids.some((id) => this._levelBaseOf(id) <= cut + 0.01)
    }
    if (doc?.level !== undefined) return this._levelBaseOf(doc.level) <= cut + 0.01
    return true
  }

  /** Is the current user a GM (sees everything)? */
  _isGM() {
    return !!game?.user?.isGM
  }

  /** GM OR Assistant GM — the gate for Free Camera + terrain sculpting/generation.
   * Players get Top Down + Character views only. Uses an explicit role threshold
   * (>= ASSISTANT) rather than game.user.isGM, whose GM-vs-Assistant semantics vary by
   * Foundry version. Per-world config overrides are a planned follow-up. */
  _canBuild() {
    const ASSISTANT = globalThis.CONST?.USER_ROLES?.ASSISTANT ?? 3
    return (game?.user?.role ?? 0) >= ASSISTANT
  }

  /**
   * Whether the current user may see a given Level. GMs (and no-token-vision
   * scenes) see all floors; players are bound to Foundry's `availableLevels` —
   * the floors where they observe a token — so a player above ground won't see a
   * cave below. The floor is the blocker; we defer to Foundry's own computation.
   */
  _userCanSeeLevel(level) {
    if (this._isGM()) return true
    try {
      const avail = canvas?.scene?.availableLevels
      if (!avail || typeof avail[Symbol.iterator] !== 'function') return true
      for (const l of avail) if (l === level || l?.id === level?.id) return true
      return false
    } catch {
      return true
    }
  }

  /** The grid-helper config for the core (span/divisions are derived from `bounds` there). */
  _buildGridJson() {
    return buildGridJson(canvas?.scene?.grid, canvas?.dimensions?.size)
  }

  /**
   * Extruded walls as viewer-core `walls[]` entries. Height uses the community
   * "Wall Height" convention (`flags["wall-height"].top/bottom`, in grid distance
   * units); walls without it get a sensible default height. (Walls still drive
   * vision/movement on Foundry's 2D layer — here they are purely visual structure.)
   */
  _buildWallsJson() {
    const placeables = canvas?.walls?.placeables || []
    if (!placeables.length) return []
    // Thin Foundry-host wrapper: gather live state + accessors, delegate the shaping to
    // the pure, unit-tested producer in overlay3d/scene-json.js.
    const ceil = this._sliceFloors !== false ? this._levelTop(this._activeLevel()) : null
    return buildWallsJson(
      placeables.map((w) => w.document),
      {
        pxPerUnit: this._pxPerUnit(),
        gridSize: canvas?.dimensions?.size || 100,
        ceilUnits: Number.isFinite(ceil) ? ceil : null,
        docInSlice: (doc) => this._docInSlice(doc),
        wallBand: (doc) => this._wallBand(doc),
        assetUrl: (src) => this._assetUrl(src),
        wall3dDefaults: (doc) => this._wall3dDefaults(doc),
      },
    )
  }

  /**
   * The Level document a wall's per-level 3D defaults should come from. A wall
   * EXPLICITLY assigned to one level → that level. Assigned to several → the one
   * whose elevation range contains the wall's bottom band (else the lowest). A
   * wall on ALL levels (no explicit assignment) → null: no single-level default
   * applies, so the scene-wide default is used instead.
   */
  _wallLevel(doc) {
    const lvls = canvas?.scene?.levels
    if (!lvls || !lvls.size) return null
    const ids = doc?.levels && typeof doc.levels[Symbol.iterator] === 'function' ? [...doc.levels] : []
    if (!ids.length) return null
    if (ids.length === 1) return lvls.get?.(ids[0]) || null
    const band = this._wallBand(doc)
    const pool = ids.map((id) => lvls.get?.(id)).filter(Boolean)
    for (const l of pool) {
      if (band.bottom >= this._levelBase(l) - 0.01 && band.bottom < this._levelTop(l) + 0.01) return l
    }
    return pool.sort((a, b) => this._levelBase(a) - this._levelBase(b))[0] || null
  }

  /**
   * Resolved 3D wall defaults for a segment: the wall's own level default wins
   * over the scene-wide default. buildWallsJson applies these only as fallbacks
   * under the wall's OWN flag, so a GM sets a texture/colour once per level (or
   * once per scene) instead of on every segment. Returns null-valued fields when
   * no default is set (the producer then uses the core's default palette).
   */
  _wall3dDefaults(doc) {
    const sflag = canvas?.scene?.flags?.['crit-fumble-core'] || {}
    const lflag = this._wallLevel(doc)?.flags?.['crit-fumble-core'] || {}
    return {
      texture: lflag.wallTexture || sflag.wallTexture || null,
      color: lflag.wallColor || sflag.wallColor || null,
      tileScale: lflag.wallTileScale || sflag.wallTileScale || null, // `||`: blank level value inherits the scene default
    }
  }

  /**
   * Lighting from the scene's own settings, as a viewer-core `{ambient, lights}`
   * pair: a hemisphere ambient from Foundry's computed daylight/darkness colors
   * (modulated by the darkness level), a soft directional sun for form (the core
   * positions/frames it from `bounds`, matching this file's own prior math), and
   * a point light for each AmbientLight placeable + token-emitted light (colour +
   * radius from its config).
   */
  _buildLightsJson() {
    const envc = canvas?.environment?.colors || {}
    const num = (c, dflt) => (c != null ? Number(c) : dflt)
    return buildLightsJson(
      (canvas?.lighting?.placeables || []).map((l) => l.document),
      (canvas?.tokens?.placeables || []).map((t) => t.document),
      {
        env: {
          daylight: num(envc.ambientDaylight, 0xeeeeee),
          darkCol: num(envc.ambientDarkness, 0x303030),
          brightest: num(envc.ambientBrightest ?? envc.bright, 0xffffff),
          darkness: Number(canvas?.environment?.darknessLevel ?? canvas?.scene?.environment?.darknessLevel ?? 0),
          globalLightOn: !!(canvas?.scene?.environment?.globalLight?.enabled ?? canvas?.environment?.globalLight?.enabled),
        },
        size: canvas?.dimensions?.size || 100,
        shadows: this._shadowsEnabled(),
        pxPerUnit: this._pxPerUnit(),
        docInSlice: (doc) => this._docInSlice(doc),
        tokenSizePx: (doc) => this._tokenSizePx(doc),
      },
    )
  }

  /**
   * Render tiles as floor planes at their elevation — this is how multi-floor
   * "Levels" scenes stack in 3D (a tile is a floor surface). Elevation comes
   * from the Levels module's floor band (flags.levels.rangeBottom) when present,
   * else the tile's own elevation. Skipped in tracked mode (Foundry's floor
   * already shows tiles flat).
   */
  /**
   * Tiles as floor planes at their elevation, as viewer-core `tiles[]` entries —
   * this is how multi-floor "Levels" scenes stack in 3D (a tile is a floor
   * surface). Elevation comes from the Levels module's floor band
   * (flags.levels.rangeBottom) when present, else the tile's own elevation.
   * A Tile's (x,y) is already its center (default texture anchor 0.5/0.5) — the
   * core places tiles directly at (x,y), no half-size shift needed.
   */
  _buildTilesJson() {
    return buildTilesJson((canvas?.tiles?.placeables || []).map((t) => t.document), {
      pxPerUnit: this._pxPerUnit(),
      docInSlice: (doc) => this._docInSlice(doc),
      assetUrl: (src) => this._assetUrl(src),
      terrainAt: (x, y) => this._sampleTerrain(x, y), // heightmap ground (units) so tiles sit ON the terrain
    })
  }

  /** Map note pins as viewer-core `notes[]` entries — flat billboard markers floating
   * just above the ground at their position. Pins are UI on the map, not 3D geometry. */
  _buildNotesJson() {
    return buildNotesJson(canvas?.notes?.placeables || [], (src) => this._assetUrl(src))
  }

  /** Token footprint in pixels, derived from the document (valid mid-update). */
  _tokenSizePx(doc) {
    const size = canvas?.dimensions?.size || 100
    return { w: (doc?.width || 1) * size, h: (doc?.height || 1) * size }
  }

  /**
   * The token's floor in px — its flight-stand "foot". In native v14 a token has
   * both a `level` (which floor) and an `elevation` (its absolute height); the
   * floor is the token's Level `elevation.base`. Falls back to the legacy Levels
   * module band, else absolute ground (0). Honors the null→±Infinity contract via
   * `elevation.base` so an open band never yields ±Infinity.
   */
  _tokenFloorBasePx(doc) {
    try {
      const id = doc?.level
      const lvls = canvas?.scene?.levels
      if (id && lvls) {
        const lvl = typeof lvls.get === 'function' ? lvls.get(id) : (lvls.contents || lvls)?.find?.((l) => l.id === id)
        const base = lvl?.elevation?.base
        if (Number.isFinite(Number(base))) return Number(base) * this._pxPerUnit()
        const bottom = lvl?.elevation?.bottom
        if (Number.isFinite(Number(bottom))) return Number(bottom) * this._pxPerUnit()
      }
      const rb = doc?.flags?.levels?.rangeBottom // legacy Levels module floor band
      if (Number.isFinite(Number(rb))) return Number(rb) * this._pxPerUnit()
    } catch {
      /* fall through to ground */
    }
    return 0
  }

  /**
   * A Foundry token document as a viewer-core token JSON entry (ring + optional
   * flight-stand stalk are built into `createViewer()`'s `addToken` from
   * `elevation`/`floorElevation` — see core.ts). Position is derived from the
   * DOCUMENT (not the placeable) so this is correct both at full rebuild and
   * mid-`updateToken`, when the placeable's `.center` still holds the pre-move
   * value. Returns null for tokens that shouldn't render (floor-sliced, or
   * hidden-from-this-player per Foundry's own placeable visibility).
   */
  _tokenJson(doc) {
    if (!doc) return null
    if (!this._docInSlice(doc)) return null // token on a floor above the slice → hidden
    const placeable = canvas?.tokens?.get?.(doc.id)
    // Players: only render tokens Foundry shows them — its placeable visibility already
    // respects vision, fog of war, the hidden flag, and floor access.
    if (!this._isGM() && !placeable?.visible) return null
    // Flight-stand model (BASE on the token's floor, mini floating at its own elevation,
    // post between) is shaped in the pure producer; the gating above stays host-side.
    const px = this._pxPerUnit()
    const size = canvas?.dimensions?.size || 100
    const cx = (doc?.x || 0) + ((Number(doc?.width) || 1) * size) / 2
    const cy = (doc?.y || 0) + ((Number(doc?.height) || 1) * size) / 2
    // On heightmap terrain the ground varies, so Foundry's (flat-scene) elevation is treated
    // as height ABOVE the local surface: lift BOTH the token and its floor by the terrain
    // height so a ground token sits ON the surface instead of being buried at sea level.
    const terrainUnits = this._sampleTerrain(cx, cy)
    return buildTokenJson(doc, {
      pxPerUnit: px,
      sizePx: this._tokenSizePx(doc),
      floorElevation: terrainUnits != null ? terrainUnits * px : this._tokenFloorBasePx(doc),
      groundOffsetUnits: terrainUnits != null ? terrainUnits : 0,
      assetUrl: (src) => this._assetUrl(src),
      selected: !!placeable?.controlled, // viewer controls it → selection ring
      targeted: !!placeable?.isTargeted, // viewer targets it → reticle halo
      targetColor: this._targetColor(),
    })
  }

  /** The current user's colour as a 0xRRGGBB number (for the target reticle), or undefined. */
  _targetColor() {
    const c = game?.user?.color
    if (c == null) return undefined
    const n = typeof c === 'number' ? c : parseInt(String(c).replace('#', ''), 16)
    return Number.isFinite(n) ? n : undefined
  }

  /**
   * Re-sync a single token on its `updateToken`/`moveToken` broadcast (fires on
   * every client — this is the "free multiplayer"). Remove + re-add (via the
   * viewer's `applyDelta`) so position, elevation, the height stalk, and size all
   * stay correct — a plain in-place move wouldn't refresh the ring/stalk offsets.
   *
   * Skipped for the actively-tracked first-person subject: with `teleport` gone,
   * Foundry's own movement pipeline animates the document's x/y progressively and
   * fires this hook one or more times mid-animation with a still-in-flight
   * position — rebuilding the group from that reads a stale/partial value and
   * races with `_fpSyncSubjectVisual` (which repositions the SAME group every
   * frame from local `_fpCenter`, already fully accurate — including external
   * moves, via the idle-sync branch in `_fpStep`). Skipping here is what actually
   * fixes the jitter; every other token still rebuilds normally.
   */
  _onUpdateToken(doc, change = {}) {
    if (!this._visible || !this._mounted) return
    try {
      const id = doc?.id
      if (!id) {
        this._scheduleRebuild()
        return
      }
      if (this._mode === 'firstperson' && id === this._fpMoverId) {
        // The MOVER's x/y is driven locally (`_fpSyncSubjectVisual` + `_fpCenter`) so pure
        // position moves skip the rebuild (that's the anti-jitter). But a VISUAL change — most
        // notably elevation (Q/E), which reshapes the height stalk/base — must rebuild, or the
        // pole stays stale until the next camera toggle. Elevation is handled per-frame in
        // `_fpStep` (`_rebuildSubject`); here we only rebuild for OTHER visual changes. A token
        // that is the subject but NOT the mover falls through and rebuilds normally on an
        // external move so its mini/stalk stay synced with the camera.
        const c = change || {}
        const visual = 'width' in c || 'height' in c || 'texture' in c || 'flags' in c || 'hidden' in c
        if (!visual) return
      }
      this._removeToken(id)
      // Re-read the live document (all floors) so x/y/elevation/level are current.
      const fresh = canvas?.scene?.tokens?.get?.(id) || doc
      const t = this._tokenJson(fresh)
      if (t) this._viewer.applyDelta({ tokens: [t] })
      this._render()
    } catch {
      this._scheduleRebuild()
    }
  }

  /** Remove one token's 3D objects (group + ring + stalk, all children of the
   * group now) via the viewer's own remove-and-dispose path. */
  _removeToken(id) {
    this._viewer?.applyDelta({ tokens: [{ id, remove: true }] })
  }

  _onCanvasReady() {
    if (this._visible) this.rebuild()
  }

  _scheduleRebuild() {
    if (!this._visible) return
    if (this._rebuildTimer) clearTimeout(this._rebuildTimer)
    this._rebuildTimer = setTimeout(() => {
      this._rebuildTimer = null
      this.rebuild()
    }, 120)
  }

  /* ------------------------------------------------------------------ */
  /*  Render loop + teardown                                             */
  /* ------------------------------------------------------------------ */

  _startLoop() {
    if (this._tickerFn) return
    this._tickerFn = () => this._tick()
    // Hook Foundry's existing render loop (its PIXI ticker) so we render in
    // lockstep with the board and stay synced to every pan/zoom frame.
    if (canvas?.app?.ticker) canvas.app.ticker.add(this._tickerFn, this)
    else {
      const loop = () => {
        this._raf = requestAnimationFrame(loop)
        this._tick()
      }
      loop()
    }
  }

  _stopLoop() {
    if (this._tickerFn && canvas?.app?.ticker) canvas.app.ticker.remove(this._tickerFn, this)
    this._tickerFn = null
    if (this._raf) {
      cancelAnimationFrame(this._raf)
      this._raf = null
    }
  }

  /** Per-frame: keep the tracked camera synced (or orbit damping), then render. */
  _tick() {
    if (!this._visible || !this._renderer || !this._camera) return
    this._updateCompass()
    this._updateMoveRuler() // live movement path + distance (Top Down + Character)
    this._updateSelectionBrackets() // Foundry-style corner brackets on controlled tokens
    // Free Camera: the shared ViewerControls runs its own rAF loop (damping + input +
    // render-on-change), so this ticker yields to it — no double update/render.
    if (this._mode === 'orbit' && this._sharedControls) return
    if (this._mode === 'tracked') this._syncTrackedCamera()
    else if (this._mode === 'firstperson') this._fpStep(typeof performance !== 'undefined' ? performance.now() : 0)
    else this._controls?.update()
    try {
      this._renderer.render(this._scene, this._camera)
    } catch {
      /* renderer not ready yet — the next tick will catch up */
    }
  }

  /** Single render outside the loop (e.g. async texture/model arrival). */
  _render() {
    if (this._renderer && this._scene && this._camera) {
      try {
        this._renderer.render(this._scene, this._camera)
      } catch {
        /* not ready */
      }
    }
  }

  /** Empty the 3D scene (all THREE-object disposal lives in the viewer core now). */
  _clearScene() {
    this._viewer?.loadScene({})
    this._ready = false
  }

  destroy() {
    this._stopLoop()
    this._setFpInput(false)
    document.body.classList.remove('cfg-3d-active')
    for (const [hook, fn] of this._hooks) Hooks.off(hook, fn)
    this._hooks = []
    if (this._onResize) window.removeEventListener('resize', this._onResize)
    this._teardownSharedControls()
    this._controls?.dispose?.()
    this._viewer?.renderer?.forceContextLoss?.()
    this._viewer?.dispose()
    if (this._container?.parentElement) this._container.parentElement.removeChild(this._container)
    this._container = null
    this._controlBar = null
    this._viewer = null
    this._renderer = null
    this._scene = null
    this._camera = null
    this._orbitCamera = null
    this._controls = null
    this._mounted = false
    this._visible = false
    this._ready = false
  }

  /* ------------------------------------------------------------------ */
  /*  Terrain sculpt brush                                               */
  /* ------------------------------------------------------------------ */

  /** Select a sculpt brush (or null to stop). Sculpting needs an overhead/free 3D view to
   *  see + raycast the terrain, so switch to Top-Down if we're off or in Character view. */
  _setSculptMode(mode) {
    if (mode && !this._canBuild()) return // terrain sculpting is GM / Assistant GM only
    this._sculptMode = mode
    if (mode && (this._mode === 'firstperson' || !this._visible)) this.setViewMode('topdown')
    if (!mode) this._viewer?.hideBrushCursor?.()
    try {
      ui?.controls?.render?.()
    } catch {
      /* controls not ready */
    }
  }

  /**
   * Generate a STARTING height field from the scene's map image (classify land/water/beach/
   * rock by colour, erode isolated rock-noise) into the heightfield flag. This is the base
   * terrain + a one-click way to recover from over-sculpting; the GM then shapes it by hand.
   */
  async _generateTerrainFromMap() {
    if (!this._canBuild()) return // terrain generation is GM / Assistant GM only
    const scene = canvas?.scene
    const src = scene?.background?.src
    if (!src) {
      ui?.notifications?.warn?.('This scene has no background image to generate terrain from.')
      return
    }
    try {
      const cols = 80
      const rows = 80
      const url = typeof foundry?.utils?.getRoute === 'function' ? foundry.utils.getRoute(src) : src
      const img = await new Promise((ok, no) => {
        const im = new Image()
        im.crossOrigin = 'anonymous'
        im.onload = () => ok(im)
        im.onerror = () => no(new Error('image load failed'))
        im.src = url
      })
      const cv = document.createElement('canvas')
      cv.width = cols
      cv.height = rows
      const g2 = cv.getContext('2d', { willReadFrequently: true })
      g2.drawImage(img, 0, 0, cols, rows)
      const px = g2.getImageData(0, 0, cols, rows).data
      const T = new Array(cols * rows) // 0 water · 1 beach · 2 grass · 3 rock
      for (let k = 0; k < cols * rows; k++) {
        const r = px[k * 4]
        const gr = px[k * 4 + 1]
        const b = px[k * 4 + 2]
        if (b > r + 15 && b > 95 && gr > r) T[k] = 0
        else if (r > 165 && gr > 145 && b < 165 && r >= gr - 10) T[k] = 1
        else if (Math.abs(r - gr) < 20 && Math.abs(gr - b) < 20 && r > 100 && r < 200) T[k] = 3
        else T[k] = 2
      }
      const T2 = T.slice() // erode isolated rock (noise) — keep connected ridges
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const k = j * cols + i
          if (T[k] !== 3) continue
          let n = 0
          for (let dj = -1; dj <= 1; dj++) {
            for (let di = -1; di <= 1; di++) {
              if (!di && !dj) continue
              const ii = i + di
              const jj = j + dj
              if (ii >= 0 && ii < cols && jj >= 0 && jj < rows && T[jj * cols + ii] === 3) n++
            }
          }
          if (n < 2) T2[k] = 2
        }
      }
      const HT = { 0: -4, 1: 0, 2: 6, 3: 30 } // shallow water · flat beach · raised grass · tall rock
      this._sculptPushUndo(scene.flags?.['crit-fumble-core']?.heightfield?.heights) // undoable
      await scene.setFlag('crit-fumble-core', 'heightfield', { cols, rows, heights: T2.map((t) => HT[t]) })
      ui?.notifications?.info?.('Generated 3D terrain from the map — sculpt from here.')
    } catch (e) {
      console.warn('CFG Core | generate terrain from map failed', e)
      ui?.notifications?.error?.('Terrain generation failed (see console).')
    }
  }

  /** True while a sculpt tool is active — the drag sculpts instead of panning/picking. */
  _sculptActive() {
    return !!this._sculptMode && this._visible
  }

  /** Start a sculpt stroke: snapshot the scene's height field into a live working copy. */
  _sculptBegin(event) {
    const field = canvas?.scene?.flags?.['crit-fumble-core']?.heightfield
    if (!field?.heights?.length) {
      ui?.notifications?.warn?.('No 3D terrain on this scene yet — add a heightfield first.')
      return
    }
    this._sculptCols = Math.floor(Number(field.cols))
    this._sculptRows = Math.floor(Number(field.rows))
    this._sculptPushUndo(field.heights) // snapshot the pre-stroke state for undo
    this._sculptHeights = field.heights.slice()
    this._sculptDrag = true
    if (this._sculptMode === 'level') {
      const uv = this._viewer?.raycastTerrain?.(event.clientX, event.clientY)
      const i = uv ? Math.round(uv.u * (this._sculptCols - 1)) : 0
      const j = uv ? Math.round(uv.v * (this._sculptRows - 1)) : 0
      this._sculptLevel = Number(this._sculptHeights[j * this._sculptCols + i]) || 0
    }
    this._sculptApply(event)
  }

  /** Apply one brush dab under the cursor + re-displace the terrain mesh in place. */
  _sculptApply(event) {
    if (!this._sculptDrag || !this._sculptHeights) return
    const uv = this._viewer?.raycastTerrain?.(event.clientX, event.clientY)
    if (!uv) return
    const raise = this._sculptMode === 'raise' || this._sculptMode === 'lower'
    this._sculptHeights = applyTerrainBrush(this._sculptHeights, this._sculptCols, this._sculptRows, {
      mode: this._sculptMode,
      u: uv.u,
      v: uv.v,
      radius: this._sculptRadius,
      strength: raise ? this._sculptStrength : 0.5,
      level: this._sculptLevel || 0,
    })
    const px = this._pxPerUnit()
    this._viewer?.updateTerrainHeights?.(this._sculptHeights.map((val) => val * px))
  }

  /** End the stroke: persist the height field to the scene flag (multiplayer + reload). */
  _sculptEnd() {
    this._sculptDrag = false
    const h = this._sculptHeights
    this._sculptHeights = null
    if (!h) return
    try {
      canvas?.scene?.setFlag?.('crit-fumble-core', 'heightfield', { cols: this._sculptCols, rows: this._sculptRows, heights: h })
    } catch {
      /* not a GM / no scene */
    }
  }

  /** Push a height-field snapshot (units) onto the undo stack, capped at 24 strokes. */
  _sculptPushUndo(heights) {
    if (!Array.isArray(heights)) return
    this._sculptUndoStack.push(heights.slice())
    if (this._sculptUndoStack.length > 24) this._sculptUndoStack.shift()
  }

  /** Undo the last sculpt stroke (or Generate): restore the previous height field. Bound to
   *  Cmd/Ctrl-Z in a 3D view + the Undo tool. */
  _sculptUndo() {
    const heights = this._sculptUndoStack.pop()
    if (!heights) {
      ui?.notifications?.info?.('Nothing to undo')
      return
    }
    const field = canvas?.scene?.flags?.['crit-fumble-core']?.heightfield
    const cols = Math.floor(Number(field?.cols)) || this._sculptCols
    const rows = Math.floor(Number(field?.rows)) || this._sculptRows
    const px = this._pxPerUnit()
    this._viewer?.updateTerrainHeights?.(heights.map((v) => v * px)) // immediate in-place restore
    try {
      canvas?.scene?.setFlag?.('crit-fumble-core', 'heightfield', { cols, rows, heights }) // persist + sync
    } catch {
      /* not a GM / no scene */
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Scene-control toggle (Foundry v13/v14 Record API)                  */
  /* ------------------------------------------------------------------ */

  /**
   * Register a top-level "3D View" scene-control group (its own left-toolbar
   * button with nested tools), rather than a single tool tucked under Tokens.
   * No `layer`/`activeTool`/group `onChange` — each tool owns its behavior, so
   * entering/leaving the group never toggles the overlay (it persists).
   */
  _registerControl() {
    this._on('getSceneControlButtons', (controls) => {
      try {
        // Three 3D view modes as radio-like toggles; "2D" = none active (overlay off).
        const vm = this._currentViewMode()
        const tools = {
          topdown: {
            name: 'topdown',
            order: 0,
            title: 'Top Down (3D overhead — arrows pan · scroll zoom · click select/target)',
            icon: 'fa-solid fa-table-cells',
            toggle: true,
            active: vm === 'topdown',
            onChange: (event, active) => this.setViewMode(active ? 'topdown' : '2d'),
          },
          free: {
            name: 'free',
            order: 1,
            title: 'Free Camera (orbit — drag to rotate/tilt, scroll to zoom)',
            icon: 'fa-solid fa-video',
            toggle: true,
            active: vm === 'free',
            onChange: (event, active) => this.setViewMode(active ? 'free' : '2d'),
          },
          firstperson: {
            name: 'firstperson',
            order: 2,
            title: 'Character View (WASD move · arrows turn camera · click select/target · scroll zoom)',
            icon: 'fa-solid fa-person',
            toggle: true,
            active: vm === 'firstperson',
            onChange: (event, active) => this.setViewMode(active ? 'firstperson' : '2d'),
          },
          slice: {
            name: 'slice',
            order: 3,
            title: 'Floor slice — show the current floor + below, hide floors above',
            icon: 'fa-solid fa-layer-group',
            toggle: true,
            active: this._sliceFloors !== false,
            onChange: (event, active) => this.setSlice(active),
          },
          terrainGenerate: {
            name: 'terrainGenerate',
            order: 9,
            title: 'Generate 3D terrain from the map — a base heightmap you sculpt from (also resets over-sculpted terrain)',
            icon: 'fa-solid fa-mountain-sun',
            button: true,
            onChange: () => this._generateTerrainFromMap(),
          },
          terrainUndo: {
            name: 'terrainUndo',
            order: 8,
            title: 'Undo the last sculpt stroke (also Cmd/Ctrl-Z)',
            icon: 'fa-solid fa-rotate-left',
            button: true,
            onChange: () => this._sculptUndo(),
          },
          sculptRaise: {
            name: 'sculptRaise',
            order: 10,
            title: 'Sculpt: RAISE terrain — drag on the terrain (scroll = brush size)',
            icon: 'fa-solid fa-mound',
            toggle: true,
            active: this._sculptMode === 'raise',
            onChange: (event, active) => this._setSculptMode(active ? 'raise' : null),
          },
          sculptLower: {
            name: 'sculptLower',
            order: 11,
            title: 'Sculpt: LOWER terrain — drag on the terrain',
            icon: 'fa-solid fa-hill-rockslide',
            toggle: true,
            active: this._sculptMode === 'lower',
            onChange: (event, active) => this._setSculptMode(active ? 'lower' : null),
          },
          sculptLevel: {
            name: 'sculptLevel',
            order: 12,
            title: 'Sculpt: LEVEL/flatten — flattens to the first-click height (makes cliffs/mesas)',
            icon: 'fa-solid fa-ruler-horizontal',
            toggle: true,
            active: this._sculptMode === 'level',
            onChange: (event, active) => this._setSculptMode(active ? 'level' : null),
          },
          sculptSmooth: {
            name: 'sculptSmooth',
            order: 13,
            title: 'Sculpt: SMOOTH terrain — softens bumps and slopes',
            icon: 'fa-solid fa-wind',
            toggle: true,
            active: this._sculptMode === 'smooth',
            onChange: (event, active) => this._setSculptMode(active ? 'smooth' : null),
          },
        }
        // Gate: the whole 3D View toolbar (Top Down · Free Camera · Character · Slice ·
        // terrain tools) is GM / Assistant GM only. Players get NO 3D toolbar — their one
        // 3D entry is the Token-HUD "Character View" button (on a token they own + have
        // vision through). Config overrides are a planned follow-up.
        if (!this._canBuild()) return
        const group = { name: 'cfg-3d', order: 95, title: '3D View', icon: 'fa-solid fa-panorama', visible: true, tools }
        if (Array.isArray(controls)) {
          // Legacy (v12) array shape — tools as an array.
          controls.push({ ...group, tools: Object.values(tools) })
          return
        }
        controls['cfg-3d'] = group
      } catch (err) {
        console.warn('CFG Core | Overlay3D control registration failed:', err)
      }
    })
  }

  /** Preferred GPU power mode, passed to `createViewer()` (it owns the hardware-then-
   * software renderer fallback now). Controlled by the "3D View — GPU" setting. */
  _gpuPreference() {
    try {
      const v = game?.settings?.get?.('crit-fumble-core', 'overlay3dGpu')
      if (v === 'low-power' || v === 'default') return v
    } catch {
      /* not registered yet */
    }
    return 'high-performance'
  }

  _shadowsEnabled() {
    try {
      const v = game?.settings?.get?.('crit-fumble-core', 'overlay3dShadows')
      if (typeof v === 'boolean') return v
    } catch {
      /* not registered yet */
    }
    return true
  }

  /** Render-quality preference passed to `createViewer()` (#166). 'auto' lets the
   * core detect a tier from the GPU/device; a pinned tier overrides. Controlled by
   * the "3D View — Performance" setting. */
  _qualityPreference() {
    try {
      const v = game?.settings?.get?.('crit-fumble-core', 'overlay3dQuality')
      if (v === 'high' || v === 'medium' || v === 'low' || v === 'potato') return v
    } catch {
      /* not registered yet */
    }
    return 'auto'
  }

  /** Frame-rate cap (#166), fps number or null (uncapped). Default 15. Controlled
   * by the "3D View — Frame rate cap" setting. */
  _fpsCapPreference() {
    try {
      const v = game?.settings?.get?.('crit-fumble-core', 'overlay3dFpsCap')
      if (v === 'off') return null
      const n = Number(v)
      if (Number.isFinite(n) && n > 0) return n
    } catch {
      /* not registered yet */
    }
    return 15
  }

  /**
   * Whether selecting a token should slice the 3D view to that token's floor.
   * Off by default: the slice then follows Foundry's navigated/viewed level
   * (canvas.level) — matching Foundry's own UI behavior. A per-player setting.
   */
  _focusFollowEnabled() {
    try {
      return game?.settings?.get?.('crit-fumble-core', 'overlay3dFocusFollow') === true
    } catch {
      return false
    }
  }


  /** First-person fine movement: true → W/S move smoothly; false (default) → one grid step per press. */
  _fineMovement() {
    try {
      return game?.settings?.get?.('crit-fumble-core', 'overlay3dFineMovement') === true
    } catch {
      return false
    }
  }

  /** Register the client settings for the 3D view (GPU preference + shadows). */
  _registerSettings() {
    const notify = () => {
      try {
        ui.notifications?.info?.('CFG 3D: toggle the 3D view off and on to apply.')
      } catch {
        /* non-fatal */
      }
    }
    const reg = (key, data) => {
      try {
        game.settings.register('crit-fumble-core', key, data)
      } catch {
        /* already registered / unavailable */
      }
    }
    reg('overlay3dGpu', {
      name: '3D View — GPU',
      hint: 'Prefer the high-performance GPU for the 3D view; falls back to software if no hardware GPU is available.',
      scope: 'client',
      config: true,
      type: String,
      choices: { 'high-performance': 'High performance (GPU)', default: 'Default', 'low-power': 'Low power' },
      default: 'high-performance',
      onChange: notify,
    })
    reg('overlay3dShadows', {
      name: '3D View — Dynamic shadows',
      hint: 'Walls and objects cast shadows from lights. Turn off on low-end GPUs.',
      scope: 'client',
      config: true,
      type: Boolean,
      default: true,
      onChange: notify,
    })
    reg('overlay3dQuality', {
      name: '3D View — Performance',
      hint: 'Auto (recommended) picks a quality tier from your GPU — Steam Deck / laptops step down automatically, and it caps lights so big scenes still load. Pin a lower tier for more speed (fewer lights, lower resolution, no shadows). The view also auto-scales resolution live to keep motion smooth.',
      scope: 'client',
      config: true,
      type: String,
      choices: { auto: 'Auto (recommended)', high: 'High', medium: 'Medium', low: 'Low', potato: 'Potato (max speed)' },
      default: 'auto',
      onChange: notify,
    })
    reg('overlay3dFpsCap', {
      name: '3D View — Frame rate cap',
      hint: 'Limit the 3D view to this frame rate. A steady low cap (15 fps, default) is smoother and much lighter on older / integrated GPUs than an uncapped, stuttering higher rate. Applies live.',
      scope: 'client',
      config: true,
      type: String,
      choices: { '15': '15 fps (default)', '30': '30 fps', '60': '60 fps', off: 'Uncapped' },
      default: '15',
      onChange: (v) => {
        const cap = v === 'off' ? null : Number.isFinite(Number(v)) ? Number(v) : 15
        try {
          this._viewer?.setFpsCap?.(cap)
        } catch {
          /* viewer not open — applies on next createViewer via _fpsCapPreference */
        }
      },
    })
    reg('overlay3dFocusFollow', {
      name: '3D View — Follow selected token’s floor',
      hint: 'When on, selecting a token slices the 3D view to that token’s floor (hiding the floors above it). When off (default), the 3D view follows the floor you navigate to with Foundry’s level controls.',
      scope: 'client',
      config: true,
      type: Boolean,
      default: false,
      onChange: () => {
        try {
          if (this._visible) this.rebuild()
        } catch {
          /* non-fatal */
        }
      },
    })
    reg('overlay3dFineMovement', {
      name: '3D View — First-person fine movement',
      hint: 'On: W/S move smoothly (hold to walk). Off: W/S step one grid square per press. Walls block movement either way.',
      scope: 'client',
      config: true,
      type: Boolean,
      default: false,
    })
  }

  /**
   * Inject the stylesheet that hides 2D-anchored interactive UI (Token HUD,
   * tooltips) while the 3D view is active — Foundry positions those for the
   * top-down camera, so they'd float mispositioned over the orbit view.
   */
  _injectUiStyle() {
    if (document.getElementById('cfg-3d-ui-style')) return
    const style = document.createElement('style')
    style.id = 'cfg-3d-ui-style'
    style.textContent =
      'body.cfg-3d-active #hud, body.cfg-3d-active #tooltip { display: none !important; }' +
      // Re-show the Token HUD over the 3D view when the user right-clicks a token (the
      // service positions it over the token's 3D screen position).
      'body.cfg-3d-active.cfg-3d-show-hud #hud { display: block !important; }'
    document.head.appendChild(style)
  }

  /** Re-render the scene controls so the toggle's active state reflects reality. */
  _syncControlState() {
    try {
      ui?.controls?.render?.({ reset: true })
    } catch {
      /* non-fatal */
    }
  }
}
