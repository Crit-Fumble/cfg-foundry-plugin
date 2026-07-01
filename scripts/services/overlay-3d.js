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

const OVERLAY_ID = 'cfg-3d-overlay'

/** Foundry CONST.TOKEN_DISPOSITIONS → a tint for placeholder/footprint marks. */
function dispositionColor(disposition) {
  switch (disposition) {
    case 1:
      return 0x4caf50 // friendly
    case -1:
      return 0xf44336 // hostile
    case -2:
      return 0x9c27b0 // secret
    default:
      return 0x2196f3 // neutral
  }
}

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
    /** @type {{w:boolean,a:boolean,s:boolean,d:boolean}} held WASD keys (first-person) */
    this._keys = { w: false, a: false, s: false, d: false }
    /** @type {((e: KeyboardEvent) => void)|null} first-person key-up handler */
    this._keyUpHandler = null
    // First-person local camera state — driven smoothly, committed to the token on a throttle.
    this._fpHeading = 0
    this._fpPitch = 0
    this._fpCenter = null
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
        if (this._mode === 'firstperson') this._fpCenter = null // re-anchor first-person to the new subject
        // Rebuild on focus-follow (slice) or in first-person (to hide the new subject).
        if (this._focusFollowEnabled() || this._mode === 'firstperson') this._scheduleRebuild()
      })
      this._on('updateToken', (doc) => this._onUpdateToken(doc))
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
        await this._mount()
        await this.rebuild()
        if (this._container) this._container.style.display = 'block'
        this._applyMode() // active camera + input routing + UI-hide (orbit only)
        this._updateControlBar()
        this._startLoop()
      } else {
        this._stopLoop()
        this._setFpInput(false)
        document.body.classList.remove('cfg-3d-active')
        if (this._container) this._container.style.display = 'none'
      }
      this._syncControlState()
    } catch (err) {
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
    })
    this._viewer = viewer
    this._renderer = viewer.renderer
    this._scene = viewer.scene
    this._camera = viewer.camera
    this._orbitCamera = viewer.camera

    const renderer = viewer.renderer
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
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
    this._render()
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
    const tok = this._firstPersonToken()
    if (!tok?.document) return
    if (this._fpCenter == null) this._fpSyncLocalFromToken(tok)
    if (!this._charAzimuthInit) {
      // Seed the camera behind the token's entry facing; it then stays put while the
      // token turns to the cursor independently (left-drag orbit can adjust it later).
      this._charAzimuth = (((this._fpHeading + 270) % 360) * Math.PI) / 180
      this._charAzimuthInit = true
    }
    const dt = this._fpLastTick ? Math.min(0.1, (now - this._fpLastTick) / 1000) : 0
    this._fpLastTick = now
    const k = this._keys
    if (dt > 0 && this._fineMovement() && (k.w || k.a || k.s || k.d)) {
      let mx = 0
      let mz = 0
      for (const key of ['w', 'a', 's', 'd']) {
        if (!k[key]) continue
        const d = this._fpMoveDir(key)
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
          this._faceMoveDir({ x: mx / len, z: mz / len }) // face where we walk
          this._fpDirty = true
        }
      }
    }
    if (this._fpDirty) {
      if (now - (this._fpCommitAt || 0) > 90) this._fpCommitNow(tok) // throttle writes
    } else if (!k.w && !k.a && !k.s && !k.d) {
      this._fpSyncLocalFromToken(tok) // idle → follow the token (external moves, discrete commits)
    }
    this._charUpdateSubjectVisibility(tok)
    this._fpSyncSubjectVisual(tok)
    this._fpPositionCamera(tok)
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
    const elevPx = Number(tok.document.elevation || 0) * this._pxPerUnit()
    g.position.set(this._fpCenter.x, elevPx, this._fpCenter.y)
  }

  /** A unit move direction (world XZ) for a WASD key, relative to the CAMERA
   * (Action-RPG): W = into the screen (away from the camera), S back, A/D screen
   * left/right. The token aims independently at the cursor. */
  _fpMoveDir(key) {
    // _charAzimuth points from the token TO the camera; "forward" (into the screen)
    // is the opposite — the direction the camera looks.
    const f = { x: -Math.cos(this._charAzimuth), z: -Math.sin(this._charAzimuth) }
    const r = { x: -f.z, z: f.x } // screen-right = forward rotated 90° in world XZ
    if (key === 'w') return f
    if (key === 's') return { x: -f.x, z: -f.z }
    if (key === 'd') return r
    if (key === 'a') return { x: -r.x, z: -r.z }
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
    const eyeY = (Number(tok.document.elevation) || 0) * this._pxPerUnit() + size * 0.9 // ~eye height
    const cx = this._fpCenter.x
    const cz = this._fpCenter.y
    cam.up.set(0, 1, 0)
    if (this._charDist < size * 0.5) {
      // First person: at the eyes, looking where the token faces (the cursor).
      const theta = (this._fpHeading + 90) * (Math.PI / 180)
      cam.position.set(cx, eyeY, cz)
      cam.lookAt(cx + Math.cos(theta) * size, eyeY, cz + Math.sin(theta) * size)
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

  /**
   * Aim the token's facing at the cursor's position on its floor plane: raycast from
   * the camera through the cursor to the ground at the token's elevation, then face
   * that point. Sets _fpHeading + marks dirty so the new facing commits.
   */
  /** Turn the token to face a movement direction (world XZ) — it faces where it walks. */
  _faceMoveDir(dir) {
    if (!dir || (dir.x === 0 && dir.z === 0)) return
    this._fpHeading = (((Math.atan2(dir.z, dir.x) * 180) / Math.PI - 90) % 360 + 360) % 360
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

  /** Click a 3D token → select (left) or target (right / Shift-left) — native selection. */
  _onPickClick(event) {
    if (!this._visible) return // 3D picking works in every 3D mode
    const tok = this._pick(event.clientX, event.clientY)
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
      // showRuler: our update has no `method` (defaults to "api"), which — unlike
      // Foundry's own "dragging" — defaults showRuler to false. Ask for it explicitly
      // so the native measuring ruler appears during the move, same as the 2D view.
      doc.update(
        { x: Math.round(this._fpCenter.x - w / 2), y: Math.round(this._fpCenter.y - h / 2), rotation: Math.round(this._fpHeading) },
        { showRuler: true },
      )
    } catch {
      /* permission / movement rejected — ignore */
    }
    this._fpCommitAt = typeof performance !== 'undefined' ? performance.now() : 0
    this._fpDirty = false
  }

  /** One grid-step in a unit direction (world XZ), blocked by walls. */
  _fpGridStep(tok, dir) {
    const size = canvas?.dimensions?.size || 100
    const dest = { x: this._fpCenter.x + dir.x * size, y: this._fpCenter.y + dir.z * size }
    if (this._moveBlocked(this._fpCenter, dest)) return // a wall blocks the step
    this._fpCenter = dest
    this._faceMoveDir(dir) // face where we walk
    this._fpCommitNow(tok)
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
   * Enable/disable first-person input: WASD (capture phase, preempting Foundry's
   * keys) for movement — W/S forward/back, A/D strafe — and the mouse WHEEL for
   * turning (Foundry's rotation snap: 15°, or 45° with Shift). Turning is a
   * deliberate, separate action, so strafing never changes facing.
   */
  _setFpInput(on) {
    if (on && !this._keyHandler) {
      this._keyHandler = (e) => this._onKeyDown(e)
      this._keyUpHandler = (e) => this._onKeyUp(e)
      this._wheelHandler = (e) => this._onWheel(e)
      this._charMoveHandler = (e) => this._onPickMove(e)
      this._charClickHandler = (e) => this._onPickClick(e)
      window.addEventListener('keydown', this._keyHandler, true)
      window.addEventListener('keyup', this._keyUpHandler, true)
      this._container?.addEventListener('wheel', this._wheelHandler, { passive: false, capture: true })
      this._container?.addEventListener('mousemove', this._charMoveHandler)
      this._container?.addEventListener('mousedown', this._charClickHandler)
      this._keys = { w: false, a: false, s: false, d: false }
      this._fpCenter = null
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
      this._keyHandler = null
      this._keyUpHandler = null
      this._wheelHandler = null
      this._charMoveHandler = null
      this._charClickHandler = null
      this._cursor = null
      // clear any 3D-pick hover mirrored onto Foundry
      try {
        const hov = this._pickHoverId && canvas?.tokens?.get?.(this._pickHoverId)
        if (hov) hov._onHoverOut?.()
      } catch {
        /* ignore */
      }
      this._pickHoverId = null
      this._keys = { w: false, a: false, s: false, d: false }
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
  }

  /**
   * First-person WASD keydown: track held keys (fine movement runs per frame),
   * and step one grid on the initial press in grid mode — W/S forward/back, A/D
   * move relative to the camera (the cursor aims the token). Walls block
   * movement. Intercepted so Foundry's own keys don't also fire; ignored while
   * typing in a field.
   */
  _onKeyDown(event) {
    if (!this._visible) return
    const m = this._mode
    if (m !== 'firstperson' && m !== 'tracked') return // Free/2D: leave keys native
    const t = event.target
    const tag = (t?.tagName || '').toLowerCase()
    if (tag === 'input' || tag === 'textarea' || t?.isContentEditable) return
    const key = (event.key || '').toLowerCase()
    const isArrow = key === 'arrowleft' || key === 'arrowright' || key === 'arrowup' || key === 'arrowdown'
    // Top-Down: arrow keys PAN the camera focus across the board.
    if (m === 'tracked') {
      if (!isArrow) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (!this._trackFocus) this._trackFocus = this._defaultTrackFocus()
      const step = (canvas?.dimensions?.size || 100) * 1.5
      if (key === 'arrowleft') this._trackFocus.x -= step
      else if (key === 'arrowright') this._trackFocus.x += step
      else if (key === 'arrowup') this._trackFocus.z -= step
      else this._trackFocus.z += step
      this._syncTrackedCamera()
      this._render()
      return
    }
    // First-person: WASD move + arrows orbit the camera.
    const isWasd = key === 'w' || key === 'a' || key === 's' || key === 'd'
    if (!isArrow && !isWasd) return // leave every other key native (targeting, etc.)
    const tok = this._firstPersonToken()
    if (!tok?.document) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (this._fpCenter == null) this._fpSyncLocalFromToken(tok)
    if (isArrow) {
      const yaw = (Math.PI / 180) * 6
      if (key === 'arrowleft') this._charAzimuth -= yaw
      else if (key === 'arrowright') this._charAzimuth += yaw
      else if (key === 'arrowup') this._charPitch = Math.min(85, this._charPitch + 4)
      else this._charPitch = Math.max(5, this._charPitch - 4)
      this._charAzimuthInit = true // the user is steering the camera now
      this._fpPositionCamera(tok)
      return
    }
    // WASD moves the token (camera-relative); it faces its movement direction.
    this._keys[key] = true
    if (event.repeat) return // grid steps fire once per press; fine movement is per-frame
    if (!this._fineMovement()) this._fpGridStep(tok, this._fpMoveDir(key))
  }

  /** First-person WASD keyup: release the key; commit the final pose when idle. */
  _onKeyUp(event) {
    const key = (event.key || '').toLowerCase()
    if (key !== 'w' && key !== 'a' && key !== 's' && key !== 'd') return
    this._keys[key] = false
    if (!this._keys.w && !this._keys.a && !this._keys.s && !this._keys.d && this._fpDirty) {
      const tok = this._firstPersonToken()
      if (tok?.document) this._fpCommitNow(tok)
    }
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
    if (this._controls) this._controls.enabled = m === 'orbit' // drag-orbit only in Free Camera
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
    else if (m === 'firstperson') this._fpStep(typeof performance !== 'undefined' ? performance.now() : 0)
    else this._syncTrackedCamera() // TRUE top-down (directly overhead)
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
    if (mode === '2d') {
      await this.setVisible(false)
      this._updateControlBar()
      this._syncControlState()
      return
    }
    const cam = mode === 'topdown' ? 'tracked' : mode === 'firstperson' ? 'firstperson' : 'orbit'
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
        ? 'WASD move · arrows turn camera · click select/target · scroll zoom'
        : m === 'tracked'
          ? 'arrows pan · scroll zoom · click select/target'
          : 'drag rotate · scroll zoom · click select/target'
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
    const out = []
    const addQuad = (level, texData, which) => {
      const src = texData?.src
      if (!src) return
      if (/\.(webm|mp4|m4v|ogv)$/i.test(src)) return // video src: image-only for now
      const t = level?.textures || {}
      const at = Number(texData.alphaThreshold)
      const tint = Number(texData.tint)
      const rot = Number(t.rotation)
      out.push({
        elevation: this._levelElevPx(level, which),
        which,
        src: this._assetUrl(src),
        alphaTest: Number.isFinite(at) ? at : 0.75,
        tint: Number.isFinite(tint) && tint !== 0xffffff ? tint : undefined, // Foundry Color is a Number subclass
        rotation: Number.isFinite(rot) && rot !== 0 ? -(rot * Math.PI) / 180 : undefined,
        offsetX: Number(t.offsetX) || 0,
        offsetY: Number(t.offsetY) || 0,
      })
    }
    const scene = canvas?.scene
    const levels = scene?.levels?.contents ?? (Array.isArray(scene?.levels) ? scene.levels : [])
    if (levels.length) {
      // Sort by `sort` so equal-elevation floors keep a stable stacking order.
      const sorted = [...levels].sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0))
      const cut = this._sliceCut()
      const activeBase = this._levelBase(this._activeLevel() || sorted[sorted.length - 1])
      for (const level of sorted) {
        const lb = this._levelBase(level)
        if (lb > cut + 0.01) continue // floor above the slice → hidden (cutaway)
        if (!this._userCanSeeLevel(level)) continue // players: only floors they can access
        addQuad(level, level.background, 'bottom')
        // Roof/foreground only for floors strictly BELOW the active one, so a
        // ceiling never blocks the view down into the current floor.
        if (lb < activeBase - 0.01) addQuad(level, level.foreground, 'top')
      }
    }
    if (!out.length) {
      const src = this._backgroundSrc()
      if (src) out.push({ elevation: 0, which: 'bottom', src: this._assetUrl(src), alphaTest: 0 })
    }
    return out
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
    const b = level?.elevation?.base
    if (Number.isFinite(Number(b))) return Number(b)
    const bottom = level?.elevation?.bottom
    return Number.isFinite(Number(bottom)) ? Number(bottom) : 0
  }

  /** Base elevation of a level by id (0 if unknown). */
  _levelBaseOf(levelId) {
    if (!levelId) return 0
    const lvl = canvas?.scene?.levels?.get?.(levelId)
    return lvl ? this._levelBase(lvl) : 0
  }

  /** A Level's top elevation in grid units; +Infinity for an open (null) top. */
  _levelTop(level) {
    const t = level?.elevation?.top
    if (t === null || t === undefined) return Infinity
    return Number.isFinite(Number(t)) ? Number(t) : Infinity
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
    // Focus-follow (opt-in): a selected token's floor takes priority.
    if (this._focusFollowEnabled()) {
      const tid = canvas?.tokens?.controlled?.[0]?.document?.level
      if (tid && lvls.get?.(tid)) return lvls.get(tid)
    }
    // Otherwise follow Foundry's navigated/viewed level (its own UI behavior).
    if (canvas?.level) return canvas.level
    if (scene._view && lvls.get?.(scene._view)) return lvls.get(scene._view)
    let top = null
    for (const l of lvls.contents || []) if (!top || this._levelBase(l) > this._levelBase(top)) top = l
    return top
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
    const g = canvas?.scene?.grid
    return {
      size: canvas?.dimensions?.size || 100,
      showHelper: !(g && g.type === 0), // gridless scene → no grid
      color: g?.color != null ? Number(g.color) : 0x6688aa,
      opacity: g?.alpha != null ? Math.max(0.05, Number(g.alpha)) : 0.35,
    }
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
    const pxPerUnit = this._pxPerUnit()
    const out = []
    for (const w of placeables) {
      try {
        const doc = w.document
        if (!this._docInSlice(doc)) continue // wall only on floors above the slice → hidden
        const c = doc?.c
        if (!Array.isArray(c) || c.length < 4) continue
        const [x1, y1, x2, y2] = c
        const band = this._wallBand(doc)
        let wbottom = band.bottom
        let wtop = band.top
        // Cutaway: clip a tall, multi-floor wall to the active floor's ceiling so
        // only its current-floor section shows and it can't block the view down.
        if (this._sliceFloors !== false) {
          const ceil = this._levelTop(this._activeLevel())
          if (Number.isFinite(ceil)) wtop = Math.min(wtop, ceil)
        }
        if (wtop - wbottom < 0.01) continue // nothing left after the cut
        const len = Math.hypot(x2 - x1, y2 - y1)
        if (len < 1) continue
        out.push({ id: doc.id, x1, y1, x2, y2, bottom: wbottom * pxPerUnit, top: wtop * pxPerUnit, opacity: 0.85 })
      } catch {
        /* skip a malformed wall */
      }
    }
    return out
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
    const env = canvas?.environment?.colors || {}
    const num = (c, dflt) => (c != null ? Number(c) : dflt)
    const daylight = num(env.ambientDaylight, 0xeeeeee)
    const darkCol = num(env.ambientDarkness, 0x303030)
    const brightest = num(env.ambientBrightest ?? env.bright, 0xffffff)
    const darkness = Number(canvas?.environment?.darknessLevel ?? canvas?.scene?.environment?.darknessLevel ?? 0)
    const day = Math.max(0, Math.min(1, 1 - darkness))
    const shadows = this._shadowsEnabled()

    // Ambient dims with darkness so colored lights read and night looks like night.
    // Sun is the main shadow caster (walls block it → dynamic shadows on the floor).
    const size = canvas?.dimensions?.size || 100
    const ambient = {
      hemisphere: { sky: daylight, ground: darkCol, intensity: 0.1 + 0.6 * day },
      sun: { color: brightest, intensity: 0.35 + 0.7 * day, castShadow: shadows, shadowNormalBias: size * 0.04 },
    }

    const pxPerUnit = this._pxPerUnit()
    const lights = []
    // Foundry LightData → a point light. decay 0 because the world is in pixel
    // units (physical 1/d^2 falloff would make it invisible); `distance` is the
    // cutoff radius. The first few cast shadows (walls block them) — capped for
    // performance.
    let shadowBudget = shadows ? 4 : 0
    const addPointLight = (cfg, x, y, elevPx) => {
      if (!cfg) return
      const dim = Number(cfg.dim) || 0
      const bright = Number(cfg.bright) || 0
      if (dim <= 0 && bright <= 0) return
      const color = cfg.color != null ? Number(cfg.color) : 0xffffff
      const radius = Math.max(dim, bright) * pxPerUnit || size * 4
      const castShadow = shadowBudget > 0
      if (castShadow) shadowBudget--
      lights.push({
        x,
        y,
        elevation: elevPx + size * 0.6,
        color,
        radius,
        intensity: 1.3 + (Number(cfg.luminosity) || 0),
        castShadow,
        shadowNear: size * 0.2,
        shadowNormalBias: size * 0.05,
      })
    }
    // AmbientLight placeables → point lights.
    for (const light of canvas?.lighting?.placeables || []) {
      try {
        const d = light.document
        if (d?.hidden || !this._docInSlice(d)) continue
        addPointLight(d.config, Number(d.x) || 0, Number(d.y) || 0, (Number(d.elevation) || 0) * pxPerUnit)
      } catch {
        /* skip */
      }
    }
    // Token-emitted light (token.light) → point lights at the token position.
    for (const tok of canvas?.tokens?.placeables || []) {
      try {
        const d = tok.document
        if (!this._docInSlice(d)) continue
        const { w, h } = this._tokenSizePx(d)
        addPointLight(d?.light, (Number(d.x) || 0) + w / 2, (Number(d.y) || 0) + h / 2, (Number(d.elevation) || 0) * pxPerUnit)
      } catch {
        /* skip */
      }
    }
    return { ambient, lights }
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
    const tiles = canvas?.tiles?.placeables || []
    if (!tiles.length) return []
    const pxPerUnit = this._pxPerUnit()
    const out = []
    for (const tile of tiles) {
      try {
        const d = tile.document
        if (d?.hidden || !this._docInSlice(d)) continue
        const w = Number(d.width) || 0
        const h = Number(d.height) || 0
        if (w < 1 || h < 1) continue
        const elev = this._levelsElevation(d)
        const src = d.texture?.src
        out.push({
          id: d.id,
          x: Number(d.x) || 0,
          y: Number(d.y) || 0,
          width: w,
          height: h,
          elevation: elev * pxPerUnit,
          texture: src ? this._assetUrl(src) : null,
          alpha: Number.isFinite(Number(d.alpha)) ? Number(d.alpha) : 1,
          // No texture → tint by elevation so stacked floors read at a glance.
          color: elev > 0 ? 0x7a6a52 : 0x515b6b,
        })
      } catch {
        /* skip a malformed tile */
      }
    }
    return out
  }

  /**
   * Effective floor elevation for a document: the Levels module's floor bottom
   * (flags.levels.rangeBottom) when present, else the document's own elevation.
   */
  _levelsElevation(doc) {
    const lv = doc?.flags?.levels
    if (lv && Number.isFinite(Number(lv.rangeBottom))) return Number(lv.rangeBottom)
    return Number(doc?.elevation) || 0
  }

  /**
   * Render map note pins as flat billboard markers at their correct position.
   * Pins are UI on the map, not 3D geometry — so rather than hiding them under
   * the overlay, we float the pin icon just above the ground where the note
   * sits. (Other canvas markers — sound/light icons, templates — could be added
   * the same way.)
   */
  /**
   * Map note pins as viewer-core `notes[]` entries — flat billboard markers
   * floating just above the ground at their correct position. Pins are UI on
   * the map, not 3D geometry — this is a spatial stand-in for them.
   */
  _buildNotesJson() {
    const notes = canvas?.notes?.placeables || []
    if (!notes.length) return []
    const out = []
    for (const note of notes) {
      try {
        const doc = note.document
        const x = note.center?.x ?? doc.x ?? 0
        const y = note.center?.y ?? doc.y ?? 0
        const src = doc.texture?.src
        out.push({ id: doc.id, x, y, size: doc.iconSize || 50, texture: src ? this._assetUrl(src) : null })
      } catch {
        /* skip a malformed note */
      }
    }
    return out
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
    if (!this._isGM()) {
      // Players: only render tokens Foundry shows them — its placeable visibility
      // already respects vision, fog of war, the hidden flag, and floor access.
      const p = canvas?.tokens?.get?.(doc.id)
      if (!p?.visible) return null
    }
    const { w, h } = this._tokenSizePx(doc)
    // Flight-stand model: the BASE sits on the token's floor (its native v14
    // Level's base elevation) and the mini floats at the token's own absolute
    // `elevation`, with a post between — a tabletop "mini on a stand" always
    // traceable down to a floor, resolving the level/elevation disjoint (floor =
    // Level.base, height = token.elevation; both absolute).
    const cfgFlags = doc.flags?.['crit-fumble-core'] || {}
    const modelSrc = cfgFlags.modelSrc || cfgFlags.model3d
    return {
      id: doc.id,
      x: doc.x || 0,
      y: doc.y || 0,
      width: w,
      height: h,
      elevation: Number(doc.elevation || 0) * this._pxPerUnit(),
      floorElevation: this._tokenFloorBasePx(doc),
      color: dispositionColor(doc.disposition),
      texture: doc.texture?.src ? this._assetUrl(doc.texture.src) : null,
      model: modelSrc ? this._assetUrl(modelSrc) : null,
      modelScale: Number.isFinite(cfgFlags.modelScale) ? cfgFlags.modelScale : undefined,
      modelRotation: Number.isFinite(cfgFlags.modelRotation) ? cfgFlags.modelRotation : undefined,
    }
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
  _onUpdateToken(doc) {
    if (!this._visible || !this._mounted) return
    try {
      const id = doc?.id
      if (!id) {
        this._scheduleRebuild()
        return
      }
      if (this._mode === 'firstperson' && id === this._firstPersonToken()?.id) return
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
        }
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
    style.textContent = 'body.cfg-3d-active #hud, body.cfg-3d-active #tooltip { display: none !important; }'
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
