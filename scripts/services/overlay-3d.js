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

    this._container = null
    this._renderer = null
    this._scene = null
    this._camera = null // active camera (tracked ortho OR orbit perspective)
    this._orbitCamera = null
    this._trackedCamera = null
    this._controls = null
    this._raf = null
    this._tickerFn = null
    /**
     * 'tracked' = orthographic top-down camera mirroring Foundry's 2D pan/zoom,
     * so canvas-anchored UI (HUD, tooltips, pins) lines up over the 3D.
     * 'orbit' = free-look perspective camera (2D UI hidden — option A).
     * @type {'tracked'|'orbit'}
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
    /** @type {((e: WheelEvent) => void)|null} first-person wheel-turn handler */
    this._wheelHandler = null

    this._ground = null
    this._grid = null
    /** @type {any[]} extruded wall meshes */
    this._walls = []
    /** @type {any[]} map-note billboard markers */
    this._notes = []
    /** @type {any[]} scene lights (ambient hemisphere/sun + AmbientLight placeables) */
    this._lights = []
    /** @type {any[]} tile floor planes (rendered at their elevation / Levels floor) */
    this._tiles = []
    /** @type {any[]} native v14 Level background/foreground map planes (one per floor, at its elevation) */
    this._levelBackgrounds = []
    /** @type {boolean} floor-slice: hide floors above the active level (cutaway, like TaleSpire) */
    this._sliceFloors = true
    /** @type {any} shared wall material */
    this._wallMat = null
    /** @type {{cx:number,cz:number,span:number}|null} cached scene framing */
    this._frame = null
    /** @type {Map<string, any>} tokenId → THREE.Group */
    this._tokens = new Map()

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
      tokenCount: () => this._tokens.size,
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
    // Lazy: only fetch the bundled three.js (~730 KB, built via `npm run
    // build:three`) when the user actually opens the 3D view.
    const bundle = await import('../lib/three.bundle.js')
    this._THREE = bundle.THREE
    this._OrbitControls = bundle.OrbitControls
    this._GLTFLoader = bundle.GLTFLoader
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

    const renderer = this._createRenderer(THREE)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setSize(window.innerWidth, window.innerHeight)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.setClearColor(0x000000, 0) // transparent when scene.background is null (tracked mode)
    renderer.shadowMap.enabled = this._shadowsEnabled() // walls block light → shadows
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    container.appendChild(renderer.domElement)
    this._renderer = renderer

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0b0e13)
    this._scene = scene

    // Orbit (free-look) perspective camera.
    const orbit = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 1, 5_000_000)
    this._orbitCamera = orbit
    const controls = new this._OrbitControls(orbit, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.maxPolarAngle = Math.PI * 0.495 // don't drop below the ground plane
    this._controls = controls

    // Tracked top-down orthographic camera — mirrors Foundry's 2D pan/zoom so
    // world points project to the same screen pixels Foundry uses (its HUD,
    // tooltips, and pins then line up over the 3D). Looks straight down -Y with
    // up = -Z, so world +X → screen-right and world +Z (canvas y) → screen-down.
    const ow = window.innerWidth
    const oh = window.innerHeight
    const ortho = new THREE.OrthographicCamera(-ow / 2, ow / 2, oh / 2, -oh / 2, 1, 200000)
    ortho.up.set(0, 0, -1)
    this._trackedCamera = ortho

    this._camera = orbit

    // Lighting is built from the scene's own settings in _buildLights().
    this._buildControlBar()

    this._onResize = () => this._resize()
    window.addEventListener('resize', this._onResize)
    this._mounted = true
  }

  _resize() {
    if (!this._renderer) return
    const w = window.innerWidth
    const h = window.innerHeight
    this._renderer.setSize(w, h)
    if (this._orbitCamera) {
      this._orbitCamera.aspect = w / Math.max(1, h)
      this._orbitCamera.updateProjectionMatrix()
    }
    if (this._trackedCamera) {
      const o = this._trackedCamera
      o.left = -w / 2
      o.right = w / 2
      o.top = h / 2
      o.bottom = -h / 2
      o.updateProjectionMatrix()
    }
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

  /** Use the scene's own background color as the 3D backdrop (not a hardcoded black). */
  _applyBackground() {
    if (!this._scene || !this._THREE) return
    try {
      if (this._foundryFloor()) {
        // Transparent so Foundry's canvas (lighting/vision/fog) shows through.
        this._scene.background = null
        if (this._container) this._container.style.background = 'transparent'
        return
      }
      const color = new this._THREE.Color(this._sceneBackgroundColor())
      this._scene.background = color
      if (this._container) this._container.style.background = `#${color.getHexString()}`
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

  /** Rebuild the entire 3D scene from the live Foundry canvas. */
  async rebuild() {
    if (!this._mounted) await this._mount()
    if (!canvas?.ready || !canvas.scene) {
      this._ready = false
      return
    }
    const THREE = this._THREE
    this._clearScene()
    this._applyBackground()

    const rect = this._sceneRect()
    const cx = rect.x + rect.width / 2
    const cz = rect.y + rect.height / 2

    // Native v14 Level backgrounds first — in v14 the scene's base map IS the
    // first Level, so this renders the base map and every stacked floor at its
    // own elevation. Fall back to a single ground plane only when no Level has
    // an image (degenerate/programmatic scene → blank-slate boot).
    const levelMaps = this._buildLevelBackgrounds(rect, cx, cz)
    if (!levelMaps) this._buildGround(rect, cx, cz)
    this._buildGrid(rect, cx, cz)
    this._buildLights()
    this._buildWalls()
    this._buildTiles()
    this._buildNotes()

    // Iterate token DOCUMENTS (every floor) — not canvas placeables, which only
    // include the currently-viewed Level. A multi-floor 3D view shows them all.
    for (const doc of canvas.scene?.tokens || []) this._addToken(doc)

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
   * Mirror Foundry's 2D camera with the tracked orthographic camera so world
   * points project to the same screen pixels Foundry uses — its canvas-anchored
   * UI (HUD, tooltips, pins) then lines up over the 3D. Foundry maps
   * screen = (world - stage.pivot) * stage.scale + screenCenter.
   */
  _syncTrackedCamera() {
    const cam = this._trackedCamera
    const stage = canvas?.stage
    if (!cam || !stage) return
    const px = stage.pivot?.x ?? 0
    const pz = stage.pivot?.y ?? 0
    cam.position.set(px, 100000, pz)
    cam.lookAt(px, 0, pz)
    cam.zoom = stage.scale?.x || 1 // 1 world unit → `scale` screen px, like Foundry
    cam.updateProjectionMatrix()
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
          this._fpDirty = true
        }
      }
    }
    if (this._fpDirty) {
      if (now - (this._fpCommitAt || 0) > 90) this._fpCommitNow(tok) // throttle writes (movement + mouse-look)
    } else if (!k.w && !k.a && !k.s && !k.d) {
      this._fpSyncLocalFromToken(tok) // idle → follow the token (external moves, discrete commits)
    }
    this._fpPositionCamera(tok)
  }

  /** A unit move direction (world XZ) for a WASD key from the current heading:
   * W forward, S back, D strafe-right, A strafe-left. */
  _fpMoveDir(key) {
    const theta = (this._fpHeading + 90) * (Math.PI / 180)
    const f = { x: Math.cos(theta), z: Math.sin(theta) } // forward
    const r = { x: -Math.sin(theta), z: Math.cos(theta) } // strafe-right
    if (key === 'w') return f
    if (key === 's') return { x: -f.x, z: -f.z }
    if (key === 'd') return r
    if (key === 'a') return { x: -r.x, z: -r.z }
    return { x: 0, z: 0 }
  }

  /** Position the first-person camera from the local heading + pitch + ground point. */
  _fpPositionCamera(tok) {
    const cam = this._orbitCamera
    if (!cam || !this._fpCenter) return
    const ppu = this._pxPerUnit()
    const size = canvas?.dimensions?.size || 100
    const eyeY = (Number(tok.document.elevation) || 0) * ppu + size * 0.9 // ~eye height above the floor
    const theta = (this._fpHeading + 90) * (Math.PI / 180)
    const pitch = ((this._fpPitch || 0) * Math.PI) / 180
    const cp = Math.cos(pitch)
    cam.up.set(0, 1, 0)
    cam.position.set(this._fpCenter.x, eyeY, this._fpCenter.y)
    cam.lookAt(this._fpCenter.x + Math.cos(theta) * cp * size, eyeY + Math.sin(pitch) * size, this._fpCenter.y + Math.sin(theta) * cp * size)
    cam.updateProjectionMatrix()
  }

  /** Initialize the local camera state from a token (centre + facing). */
  _fpSyncLocalFromToken(tok) {
    const doc = tok.document
    const { w, h } = this._tokenSizePx(doc)
    this._fpCenter = tok.center ? { x: tok.center.x, y: tok.center.y } : { x: (doc.x || 0) + w / 2, y: (doc.y || 0) + h / 2 }
    this._fpHeading = Number(doc.rotation) || 0
  }

  /** Commit the local camera state (position + facing) to the token document. */
  _fpCommitNow(tok) {
    try {
      const doc = tok.document
      const { w, h } = this._tokenSizePx(doc)
      doc.update(
        { x: Math.round(this._fpCenter.x - w / 2), y: Math.round(this._fpCenter.y - h / 2), rotation: Math.round(this._fpHeading) },
        { teleport: true },
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
      window.addEventListener('keydown', this._keyHandler, true)
      window.addEventListener('keyup', this._keyUpHandler, true)
      this._container?.addEventListener('wheel', this._wheelHandler, { passive: false, capture: true })
      this._keys = { w: false, a: false, s: false, d: false }
      this._fpCenter = null
      this._fpLastTick = 0
      this._fpPitch = 0
      if (this._container) this._container.style.cursor = ''
    } else if (!on && this._keyHandler) {
      window.removeEventListener('keydown', this._keyHandler, true)
      window.removeEventListener('keyup', this._keyUpHandler, true)
      this._container?.removeEventListener('wheel', this._wheelHandler, { capture: true })
      this._keyHandler = null
      this._keyUpHandler = null
      this._wheelHandler = null
      this._keys = { w: false, a: false, s: false, d: false }
      if (this._container) this._container.style.cursor = ''
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
   * First-person: the mouse WHEEL turns the facing, using Foundry's own rotation
   * snap — 15° per notch, 45° with Shift. Turning is deliberate and separate from
   * A/D strafe. The camera turns immediately; the new facing is committed to the
   * token. (Foundry's native wheel-rotate does not reach the overlay in first
   * person, so the overlay turns the token directly with the same snap feel.)
   */
  _onWheel(event) {
    if (this._mode !== 'firstperson' || !this._visible) return
    const tok = this._firstPersonToken()
    if (!tok?.document) return
    event.preventDefault?.()
    event.stopImmediatePropagation?.()
    if (this._fpCenter == null) this._fpSyncLocalFromToken(tok)
    const step = event.shiftKey ? 45 : 15
    this._fpHeading = (((this._fpHeading + (event.deltaY > 0 ? step : -step)) % 360) + 360) % 360
    this._fpPositionCamera(tok) // turn the camera now
    this._fpCommitNow(tok) // commit the new facing to the token (a discrete intent)
  }

  /**
   * First-person WASD keydown: track held keys (fine movement runs per frame),
   * and step one grid on the initial press in grid mode — W/S forward/back, A/D
   * strafe left/right along the facing (turning is the mouse wheel). Walls block
   * movement. Intercepted so Foundry's own keys don't also fire; ignored while
   * typing in a field.
   */
  _onKeyDown(event) {
    if (this._mode !== 'firstperson' || !this._visible) return
    const t = event.target
    const tag = (t?.tagName || '').toLowerCase()
    if (tag === 'input' || tag === 'textarea' || t?.isContentEditable) return
    const key = (event.key || '').toLowerCase()
    if (key !== 'w' && key !== 'a' && key !== 's' && key !== 'd') return
    const tok = this._firstPersonToken()
    if (!tok?.document) return
    event.preventDefault()
    event.stopImmediatePropagation()
    this._keys[key] = true
    if (this._fpCenter == null) this._fpSyncLocalFromToken(tok)
    if (event.repeat) return // grid steps fire once per press; fine movement is per-frame
    if (!this._fineMovement()) this._fpGridStep(tok, this._fpMoveDir(key)) // W/S forward/back, A/D strafe
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
   * Tracked mode shows Foundry's own canvas as the floor — its computed
   * dynamic lighting, token vision, and fog of war all come through, reused as
   * the ground, with our 3D walls/tokens popping up on top. Orbit mode renders
   * a full 3D scene (our ground + 3D lighting/shadows) instead.
   */
  _foundryFloor() {
    return this._mode === 'tracked'
  }

  /** Apply the current camera mode: active camera, input routing, UI-hide. */
  _applyMode() {
    const m = this._mode
    const immersive = m === 'orbit' || m === 'firstperson' // full 3D (not transparent-over-Foundry)
    this._camera = m === 'tracked' ? this._trackedCamera : this._orbitCamera
    if (this._controls) this._controls.enabled = m === 'orbit' // first-person is driven by the token
    if (this._container) {
      // Tracked: let the mouse fall through to Foundry (pan/zoom/select) — the
      // camera follows. Immersive 3D (orbit/first-person): capture events.
      this._container.style.pointerEvents = immersive ? 'auto' : 'none'
    }
    // Immersive modes hide the misaligned 2D UI; tracked lets it show (aligned).
    document.body.classList.toggle('cfg-3d-active', this._visible && immersive)
    // First-person uses a wider FOV; restore the default for orbit.
    if (this._orbitCamera) {
      this._orbitCamera.fov = m === 'firstperson' ? 78 : 50
      this._orbitCamera.updateProjectionMatrix()
    }
    this._setFpInput(m === 'firstperson') // WASD + mouse-look only in first-person
    if (m === 'orbit') this.setView('default')
    else if (m === 'firstperson') this._fpStep(typeof performance !== 'undefined' ? performance.now() : 0)
    else this._syncTrackedCamera()
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
   * controlled token; WASD to move — A/D strafe — and the mouse wheel to turn).
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
    this._controlBar.style.display = this._visible && (m === 'orbit' || m === 'firstperson') ? '' : 'none'
    this._controlBar.textContent =
      m === 'firstperson' ? 'WASD move · A/D strafe · scroll to turn (Shift = 45°)' : 'drag rotate · scroll zoom · right-drag pan'
  }

  _buildGround(rect, cx, cz) {
    if (this._foundryFloor()) return // Foundry's own canvas is the floor
    const THREE = this._THREE
    const geo = new THREE.PlaneGeometry(rect.width, rect.height)
    let mat
    const bg = this._backgroundSrc()
    if (bg) {
      const loader = new THREE.TextureLoader()
      loader.setCrossOrigin('anonymous')
      const tex = loader.load(bg, () => this._render())
      tex.colorSpace = THREE.SRGBColorSpace
      mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0 })
    } else {
      mat = new THREE.MeshStandardMaterial({ color: 0x39414f, roughness: 1, metalness: 0 })
    }
    const plane = new THREE.Mesh(geo, mat)
    plane.rotation.x = -Math.PI / 2 // lay flat on XZ, image upright toward -Z
    plane.position.set(cx, 0, cz)
    plane.receiveShadow = true
    this._scene.add(plane)
    this._ground = plane
  }

  /**
   * Render native v14 `Level` map images as floor planes at each level's elevation.
   * In v14 a Scene's map is decomposed into embedded Level documents — the base
   * map is the first level, and stacked floors are further levels at higher
   * elevations. Each level's `background` (at elevation.bottom) and optional
   * `foreground` roof (at elevation.top) render as scene-rect-sized quads.
   *
   * Transparency comes from the image's OWN alpha channel via three.js `alphaTest`
   * (a hard cutout, seeded from the level's `alphaThreshold`) — so a holed upper
   * floor reveals the floor below it, without the depth-sort/z-fight problems that
   * `transparent` blending brings to stacked coplanar floors. (Foundry's own
   * `alphaThreshold` actually drives a CPU hit-test + a separate surface-occlusion
   * shader; we approximate the visible result with the texture's alpha + alphaTest.)
   *
   * @returns {number} how many background quads were drawn (0 → caller draws the
   *   fallback ground plane). Skipped entirely in tracked mode (Foundry's own
   *   canvas already shows the correct floor).
   */
  _buildLevelBackgrounds(rect, cx, cz) {
    if (this._foundryFloor()) return 0
    const scene = canvas?.scene
    const levels = scene?.levels?.contents ?? (Array.isArray(scene?.levels) ? scene.levels : [])
    if (!levels.length) return 0
    // Sort by `sort` so equal-elevation floors keep a stable stacking order.
    const sorted = [...levels].sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0))
    const cut = this._sliceCut()
    const activeBase = this._levelBase(this._activeLevel() || sorted[sorted.length - 1])
    let backgrounds = 0
    for (const level of sorted) {
      const lb = this._levelBase(level)
      if (lb > cut + 0.01) continue // floor above the slice → hidden (cutaway)
      if (!this._userCanSeeLevel(level)) continue // players: only floors they can access
      if (this._addLevelQuad(level, level.background, 'bottom', rect, cx, cz)) backgrounds += 1
      // Roof/foreground only for floors strictly BELOW the active one, so a
      // ceiling never blocks the view down into the current floor.
      if (lb < activeBase - 0.01) this._addLevelQuad(level, level.foreground, 'top', rect, cx, cz)
    }
    return backgrounds
  }

  /**
   * Add one scene-rect-sized textured quad for a level's background or foreground.
   * @returns {boolean} true if a quad was added (a usable image src was present).
   */
  _addLevelQuad(level, texData, which, rect, cx, cz) {
    const src = texData?.src
    if (!src) return false
    if (/\.(webm|mp4|m4v|ogv)$/i.test(src)) return false // video src: image-only for now
    const THREE = this._THREE
    const t = level?.textures || {}
    const geo = new THREE.PlaneGeometry(rect.width, rect.height) // fit='fill' (default) — texture stretches to the scene rect
    const loader = new THREE.TextureLoader()
    loader.setCrossOrigin('anonymous')
    const tex = loader.load(this._assetUrl(src), () => this._render())
    tex.colorSpace = THREE.SRGBColorSpace
    const at = Number(texData.alphaThreshold)
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 0.95,
      metalness: 0,
      side: THREE.DoubleSide,
      alphaTest: Number.isFinite(at) ? at : 0.75, // image alpha → see-through holes to the floor below
    })
    const tint = Number(texData.tint)
    if (Number.isFinite(tint) && tint !== 0xffffff) mat.color.set(tint) // Foundry Color is a Number subclass
    const plane = new THREE.Mesh(geo, mat)
    plane.rotation.x = -Math.PI / 2 // lay flat on XZ
    const rot = Number(t.rotation)
    if (Number.isFinite(rot) && rot !== 0) plane.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), -(rot * Math.PI) / 180)
    let y = this._levelElevPx(level, which)
    if (which === 'top') y += 0.6 // nudge a roof above the band top (avoids z-fight on a thin level)
    const ox = Number(t.offsetX) || 0
    const oz = Number(t.offsetY) || 0
    plane.position.set(cx + ox, y, cz + oz)
    plane.receiveShadow = true // floors catch token/wall shadows; they don't cast (holes can't cast a solid shadow)
    this._scene.add(plane)
    this._levelBackgrounds.push(plane)
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

  _buildGrid(rect, cx, cz) {
    if (this._foundryFloor()) return // Foundry's own grid shows through
    const THREE = this._THREE
    const g = canvas?.scene?.grid
    if (g && g.type === 0) return // gridless scene → no grid
    const size = canvas?.dimensions?.size || 100
    const span = Math.max(rect.width, rect.height)
    const divisions = Math.max(1, Math.round(span / size))
    const color = g?.color != null ? Number(g.color) : 0x6688aa
    const grid = new THREE.GridHelper(span, divisions, color, color)
    grid.position.set(cx, 0.5, cz)
    if (grid.material) {
      grid.material.transparent = true
      grid.material.opacity = g?.alpha != null ? Math.max(0.05, Number(g.alpha)) : 0.35
    }
    this._scene.add(grid)
    this._grid = grid
  }

  /**
   * Extrude walls into 3D. Height uses the community "Wall Height" convention
   * (`flags["wall-height"].top/bottom`, in grid distance units); walls without
   * it get a sensible default height. (Walls still drive vision/movement on
   * Foundry's 2D layer — here they are purely visual structure.)
   */
  _buildWalls() {
    const THREE = this._THREE
    const placeables = canvas?.walls?.placeables || []
    if (!placeables.length) return
    const pxPerUnit = this._pxPerUnit()
    this._wallMat = new THREE.MeshStandardMaterial({
      color: 0x9098a3,
      roughness: 0.9,
      metalness: 0,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
    })
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
        const basePx = wbottom * pxPerUnit
        const heightPx = Math.max(1, (wtop - wbottom) * pxPerUnit)
        const dx = x2 - x1
        const dz = y2 - y1
        const len = Math.hypot(dx, dz)
        if (len < 1) continue
        const box = new THREE.Mesh(new THREE.BoxGeometry(len, heightPx, 6), this._wallMat)
        box.position.set((x1 + x2) / 2, basePx + heightPx / 2, (y1 + y2) / 2)
        box.rotation.y = -Math.atan2(dz, dx)
        box.castShadow = true
        box.receiveShadow = true
        this._scene.add(box)
        this._walls.push(box)
      } catch {
        /* skip a malformed wall */
      }
    }
  }

  /**
   * Build lighting from the scene's own settings: a hemisphere ambient from
   * Foundry's computed daylight/darkness colors (modulated by the darkness
   * level), a soft sun for form, and a point light for each AmbientLight
   * placeable (colour + radius from its config).
   */
  _buildLights() {
    const THREE = this._THREE
    const env = canvas?.environment?.colors || {}
    const num = (c, dflt) => (c != null ? Number(c) : dflt)
    const daylight = num(env.ambientDaylight, 0xeeeeee)
    const darkCol = num(env.ambientDarkness, 0x303030)
    const brightest = num(env.ambientBrightest ?? env.bright, 0xffffff)
    const darkness = Number(canvas?.environment?.darknessLevel ?? canvas?.scene?.environment?.darknessLevel ?? 0)
    const day = Math.max(0, Math.min(1, 1 - darkness))

    const rect = this._sceneRect()
    const cx = rect.x + rect.width / 2
    const cz = rect.y + rect.height / 2
    const span = Math.max(rect.width, rect.height)
    const pxPerUnit = this._pxPerUnit()
    const size = canvas?.dimensions?.size || 100

    // Ambient dims with darkness so colored lights read and night looks like night.
    const hemi = new THREE.HemisphereLight(daylight, darkCol, 0.1 + 0.6 * day)
    this._scene.add(hemi)
    this._lights.push(hemi)

    // Sun — the main shadow caster (walls block it → dynamic shadows on the floor).
    // A low, side-on angle gives long, readable shadows.
    const shadows = this._shadowsEnabled()
    const sun = new THREE.DirectionalLight(brightest, 0.35 + 0.7 * day)
    sun.position.set(cx - span * 0.55, span * 0.5, cz - span * 0.4)
    sun.target.position.set(cx, 0, cz)
    sun.castShadow = shadows
    sun.shadow.mapSize.set(1024, 1024)
    const sc = sun.shadow.camera
    sc.left = -span * 0.7
    sc.right = span * 0.7
    sc.top = span * 0.7
    sc.bottom = -span * 0.7
    sc.near = span * 0.05
    sc.far = span * 2.6
    sun.shadow.bias = -0.0004
    sun.shadow.normalBias = size * 0.04
    this._scene.add(sun.target)
    this._scene.add(sun)
    this._lights.push(sun, sun.target)

    // Helper: a Foundry LightData → a three.js point light. decay 0 because the
    // world is in pixel units (physical 1/d^2 falloff would make it invisible);
    // `distance` is the cutoff radius. The first few cast shadows (walls block
    // them) — capped for performance.
    let shadowBudget = shadows ? 4 : 0
    const addPointLight = (cfg, x, y, elevPx) => {
      if (!cfg) return
      const dim = Number(cfg.dim) || 0
      const bright = Number(cfg.bright) || 0
      if (dim <= 0 && bright <= 0) return
      const color = cfg.color != null ? Number(cfg.color) : 0xffffff
      const radius = Math.max(dim, bright) * pxPerUnit || size * 4
      const pl = new THREE.PointLight(color, 1.3 + (Number(cfg.luminosity) || 0), radius, 0)
      pl.position.set(x, elevPx + size * 0.6, y)
      if (shadowBudget > 0) {
        shadowBudget--
        pl.castShadow = true
        pl.shadow.mapSize.set(512, 512)
        pl.shadow.camera.near = size * 0.2
        pl.shadow.camera.far = radius
        pl.shadow.bias = -0.0006
        pl.shadow.normalBias = size * 0.05
      }
      this._scene.add(pl)
      this._lights.push(pl)
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
  }

  /**
   * Render tiles as floor planes at their elevation — this is how multi-floor
   * "Levels" scenes stack in 3D (a tile is a floor surface). Elevation comes
   * from the Levels module's floor band (flags.levels.rangeBottom) when present,
   * else the tile's own elevation. Skipped in tracked mode (Foundry's floor
   * already shows tiles flat).
   */
  _buildTiles() {
    if (this._foundryFloor()) return
    const THREE = this._THREE
    const tiles = canvas?.tiles?.placeables || []
    if (!tiles.length) return
    const pxPerUnit = this._pxPerUnit()
    for (const tile of tiles) {
      try {
        const d = tile.document
        if (d?.hidden || !this._docInSlice(d)) continue
        const w = Number(d.width) || 0
        const h = Number(d.height) || 0
        if (w < 1 || h < 1) continue
        const elev = this._levelsElevation(d)
        const elevPx = elev * pxPerUnit
        const geo = new THREE.PlaneGeometry(w, h)
        let mat
        const src = d.texture?.src
        if (src) {
          const loader = new THREE.TextureLoader()
          loader.setCrossOrigin('anonymous')
          const tex = loader.load(src, () => this._render())
          tex.colorSpace = THREE.SRGBColorSpace
          mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, opacity: Number.isFinite(Number(d.alpha)) ? Number(d.alpha) : 1, side: THREE.DoubleSide, roughness: 0.95 })
        } else {
          // No texture → tint by elevation so stacked floors read at a glance.
          mat = new THREE.MeshStandardMaterial({ color: elev > 0 ? 0x7a6a52 : 0x515b6b, transparent: true, opacity: 0.9, side: THREE.DoubleSide, roughness: 0.95 })
        }
        const plane = new THREE.Mesh(geo, mat)
        plane.rotation.x = -Math.PI / 2
        // A Tile's (x,y) is its anchor/origin, and the default texture anchor is
        // centered (anchorX/anchorY = 0.5) — so (x,y) is ALREADY the tile's center,
        // unlike a Token whose (x,y) is the top-left. A PlaneGeometry is centered on
        // its own position, so place it at (x,y) directly; adding half-size would
        // double-shift it off the grid (verified: tile center 1100,1600 → 1260,1760).
        plane.position.set(Number(d.x) || 0, elevPx + 0.5, Number(d.y) || 0)
        plane.receiveShadow = true
        plane.castShadow = true
        this._scene.add(plane)
        this._tiles.push(plane)
      } catch {
        /* skip a malformed tile */
      }
    }
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
  _buildNotes() {
    if (this._foundryFloor()) return // Foundry's own pins show through
    const THREE = this._THREE
    const notes = canvas?.notes?.placeables || []
    if (!notes.length) return
    for (const note of notes) {
      try {
        const doc = note.document
        const x = note.center?.x ?? doc.x ?? 0
        const z = note.center?.y ?? doc.y ?? 0
        const sizePx = doc.iconSize || 50
        const mat = new THREE.SpriteMaterial({ color: 0xffd54f, transparent: true, depthTest: false })
        const sprite = new THREE.Sprite(mat)
        sprite.renderOrder = 10 // keep pins visible above geometry
        sprite.scale.set(sizePx, sizePx, 1)
        sprite.position.set(x, sizePx / 2 + 12, z) // float just above the ground
        const src = doc.texture?.src
        if (src) {
          const loader = new THREE.TextureLoader()
          loader.setCrossOrigin('anonymous')
          loader.load(src, (tex) => {
            tex.colorSpace = THREE.SRGBColorSpace
            mat.map = tex
            mat.color.set(0xffffff)
            mat.needsUpdate = true
            this._render()
          })
        }
        this._scene.add(sprite)
        this._notes.push(sprite)
      } catch {
        /* skip a malformed note */
      }
    }
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
   * A camera-facing elevation label (e.g. "+30 ft") drawn to a canvas texture.
   * A Sprite billboards for free, so the number stays readable in the straight-
   * down tracked camera — where the vertical post foreshortens to nothing.
   */
  _elevationLabelSprite(text) {
    try {
      const THREE = this._THREE
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      const font = 'bold 40px sans-serif'
      ctx.font = font
      canvas.width = Math.ceil(ctx.measureText(text).width) + 24
      canvas.height = 56
      ctx.font = font
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = 'rgba(15,18,24,0.72)'
      if (ctx.roundRect) {
        ctx.beginPath()
        ctx.roundRect(0, 0, canvas.width, canvas.height, 12)
        ctx.fill()
      } else {
        ctx.fillRect(0, 0, canvas.width, canvas.height)
      }
      ctx.fillStyle = '#ffd34d'
      ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 2)
      const tex = new THREE.CanvasTexture(canvas)
      tex.colorSpace = THREE.SRGBColorSpace
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }))
      sprite.renderOrder = 20
      const hPx = 46
      sprite.scale.set(hPx * (canvas.width / canvas.height), hPx, 1)
      return sprite
    } catch {
      return null
    }
  }

  _addToken(doc) {
    try {
      const THREE = this._THREE
      if (!doc) return
      if (this._mode === 'firstperson' && doc.id === this._firstPersonToken()?.id) return // you don't see yourself in first-person
      if (!this._docInSlice(doc)) return // token on a floor above the slice → hidden
      if (!this._isGM()) {
        // Players: only render tokens Foundry shows them — its placeable visibility
        // already respects vision, fog of war, the hidden flag, and floor access.
        const p = canvas?.tokens?.get?.(doc.id)
        if (!p?.visible) return
      }
      const { w, h } = this._tokenSizePx(doc)
      // Derive position from the document (not the placeable) so this is correct
      // both at full rebuild and mid-`updateToken`, when the placeable's
      // `.center` still holds the pre-move value.
      const center = { x: (doc.x || 0) + w / 2, y: (doc.y || 0) + h / 2 }
      // Flight-stand model: the BASE sits on the token's floor (its native v14
      // Level's base elevation) and the mini floats at the token's own absolute
      // `elevation`, with a post between. Keeps it a tabletop "mini on a stand" —
      // always traceable down to a floor — rather than a free-floating sprite,
      // and resolves the level/elevation disjoint (floor = Level.base, height =
      // token.elevation; both absolute, so the post spans base → elevation).
      const baseElevPx = this._tokenFloorBasePx(doc)
      const tokenElevPx = Number(doc.elevation || 0) * this._pxPerUnit()
      const footprint = Math.max(w, h)

      const group = new THREE.Group()
      group.position.set(center.x, tokenElevPx, center.y)

      // Base ring on the token's floor — the anchor "foot" of the stand. A ring
      // (not a disc) so the floor/grid shows through; tinted by disposition.
      const baseRing = new THREE.Mesh(
        new THREE.RingGeometry(footprint * 0.34, footprint / 2, 32),
        new THREE.MeshBasicMaterial({
          color: dispositionColor(doc.disposition),
          transparent: true,
          opacity: 0.55,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      )
      baseRing.rotation.x = -Math.PI / 2
      baseRing.position.set(center.x, baseElevPx + 0.5, center.y)
      this._scene.add(baseRing)
      group.userData.baseRing = baseRing

      // Body: a glTF/GLB 3D model if the token has one
      // (flags["crit-fumble-core"].modelSrc), otherwise the token's 2D art on a
      // camera-facing billboard. The billboard is also the fallback when a model
      // fails to load.
      const addBillboard = (tex) => {
        const mat = new THREE.SpriteMaterial({
          map: tex || null,
          color: tex ? 0xffffff : dispositionColor(doc.disposition),
          transparent: true,
        })
        const sprite = new THREE.Sprite(mat)
        // Sprite is centred on its position; lift by half-height so the bottom
        // sits on the token's elevation plane.
        const billboardH = Math.max(h, footprint)
        sprite.scale.set(w, billboardH, 1)
        sprite.position.set(0, billboardH / 2, 0)
        group.add(sprite)
        this._render()
      }
      const loadBillboardArt = () => {
        const src = doc.texture?.src
        if (!src) return addBillboard(null)
        const loader = new THREE.TextureLoader()
        loader.setCrossOrigin('anonymous')
        loader.load(
          src,
          (tex) => {
            tex.colorSpace = THREE.SRGBColorSpace
            addBillboard(tex)
          },
          undefined,
          () => addBillboard(null),
        )
      }

      const cfgFlags = doc.flags?.['crit-fumble-core'] || {}
      const modelSrc = cfgFlags.modelSrc || cfgFlags.model3d
      if (modelSrc) {
        this._loadModel(modelSrc, group, { w, h, footprint, flags: cfgFlags }, loadBillboardArt)
      } else {
        loadBillboardArt()
      }

      // The flight-stand POST from the floor up (or down) to the mini, so its
      // length reads as the height. Hidden when the token rests on its own floor
      // (base == elevation) — no clutter for the common, on-the-ground case.
      const lift = tokenElevPx - baseElevPx
      if (Math.abs(lift) > 1) {
        const stalk = new THREE.Mesh(
          new THREE.CylinderGeometry(2, 2, Math.abs(lift), 6),
          new THREE.MeshBasicMaterial({ color: 0xffc107, transparent: true, opacity: 0.5 }),
        )
        stalk.position.set(center.x, (baseElevPx + tokenElevPx) / 2, center.y)
        this._scene.add(stalk)
        group.userData.stalk = stalk

        // Signed altitude label at the mini — the cue that survives the straight-
        // down tracked camera, and the explicit number tabletop always pairs with
        // physical height. Shows the absolute elevation (matches Foundry's HUD).
        const elev = Number(doc.elevation || 0)
        const units = canvas?.scene?.grid?.units
        const label = this._elevationLabelSprite(`${elev > 0 ? '+' : ''}${elev}${units ? ' ' + units : ''}`)
        if (label) {
          label.position.set(0, Math.max(h, footprint) + footprint * 0.35, 0)
          group.add(label)
        }
      }

      this._scene.add(group)
      this._tokens.set(doc.id, group)
    } catch (err) {
      console.warn('CFG Core | Overlay3D._addToken failed:', err)
    }
  }

  /**
   * Load a glTF/GLB model for a token, scaled to its footprint and standing on
   * the elevation plane. Falls back to the 2D billboard if the model fails to
   * load. Optional token flags: `modelScale` (multiplier), `modelRotation`
   * (degrees, yaw about the up axis).
   */
  _loadModel(src, group, dims, onFail) {
    try {
      const THREE = this._THREE
      if (!this._GLTFLoader) return onFail?.()
      const loader = new this._GLTFLoader()
      loader.load(
        src,
        (gltf) => {
          try {
            const model = gltf.scene || gltf.scenes?.[0]
            if (!model) return onFail?.()
            // Scale so the model's larger horizontal dimension ≈ the token footprint.
            const userScale = Number.isFinite(dims.flags?.modelScale) ? dims.flags.modelScale : 1
            let box = new THREE.Box3().setFromObject(model)
            const size = new THREE.Vector3()
            box.getSize(size)
            const maxHoriz = Math.max(size.x, size.z) || 1
            model.scale.setScalar((dims.footprint / maxHoriz) * userScale)
            const rotDeg = Number.isFinite(dims.flags?.modelRotation) ? dims.flags.modelRotation : 0
            if (rotDeg) model.rotation.y = (rotDeg * Math.PI) / 180
            // Sit the model's base on the elevation plane (group origin y = 0).
            box = new THREE.Box3().setFromObject(model)
            model.position.y -= box.min.y
            model.traverse((c) => {
              if (c.isMesh) {
                c.castShadow = true
                c.receiveShadow = true
              }
            })
            group.add(model)
            this._render()
          } catch (e) {
            console.warn('CFG Core | Overlay3D model post-process failed:', e)
            onFail?.()
          }
        },
        undefined,
        (err) => {
          console.warn('CFG Core | Overlay3D GLB load failed, using billboard:', src, err?.message || err)
          onFail?.()
        },
      )
    } catch (e) {
      console.warn('CFG Core | Overlay3D GLTFLoader unavailable:', e)
      onFail?.()
    }
  }

  /**
   * Re-sync a single token on its `updateToken` broadcast (fires on every
   * client — this is the "free multiplayer"). We rebuild just that token from
   * the updated document so position, elevation, the height stalk, and size all
   * stay correct.
   */
  _onUpdateToken(doc) {
    if (!this._visible || !this._mounted) return
    try {
      const id = doc?.id
      if (!id) {
        this._scheduleRebuild()
        return
      }
      this._removeToken(id)
      // Re-read the live document (all floors) so x/y/elevation/level are current.
      const fresh = canvas?.scene?.tokens?.get?.(id) || doc
      this._addToken(fresh)
      this._render()
    } catch {
      this._scheduleRebuild()
    }
  }

  /** Remove one token's 3D objects (group + height stalk) and dispose them. */
  _removeToken(id) {
    const group = this._tokens.get(id)
    if (!group) return
    // The post and base ring live at scene level (not in the group) — dispose both.
    for (const key of ['stalk', 'baseRing']) {
      const obj = group.userData?.[key]
      if (obj) {
        this._scene.remove(obj)
        this._disposeObject(obj)
      }
    }
    this._scene.remove(group)
    this._disposeObject(group)
    this._tokens.delete(id)
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

  _disposeObject(obj) {
    if (!obj) return
    obj.traverse?.((child) => {
      child.geometry?.dispose?.()
      const mat = child.material
      if (Array.isArray(mat)) mat.forEach((m) => this._disposeMaterial(m))
      else this._disposeMaterial(mat)
    })
    if (obj.geometry) obj.geometry.dispose?.()
    this._disposeMaterial(obj.material)
  }

  _disposeMaterial(mat) {
    if (!mat) return
    mat.map?.dispose?.()
    mat.dispose?.()
  }

  _clearScene() {
    if (!this._scene) return
    for (const id of [...this._tokens.keys()]) this._removeToken(id)
    if (this._ground) {
      this._scene.remove(this._ground)
      this._disposeObject(this._ground)
      this._ground = null
    }
    if (this._grid) {
      this._scene.remove(this._grid)
      this._disposeObject(this._grid)
      this._grid = null
    }
    for (const box of this._walls) {
      this._scene.remove(box)
      box.geometry?.dispose?.()
    }
    this._walls = []
    this._wallMat?.dispose?.()
    this._wallMat = null
    for (const s of this._notes) {
      this._scene.remove(s)
      this._disposeObject(s)
    }
    this._notes = []
    for (const l of this._lights) this._scene.remove(l)
    this._lights = []
    for (const t of this._tiles) {
      this._scene.remove(t)
      this._disposeObject(t)
    }
    this._tiles = []
    for (const m of this._levelBackgrounds) {
      this._scene.remove(m)
      this._disposeObject(m)
    }
    this._levelBackgrounds = []
    this._ready = false
  }

  destroy() {
    this._stopLoop()
    this._setFpInput(false)
    document.body.classList.remove('cfg-3d-active')
    this._clearScene()
    for (const [hook, fn] of this._hooks) Hooks.off(hook, fn)
    this._hooks = []
    if (this._onResize) window.removeEventListener('resize', this._onResize)
    this._controls?.dispose?.()
    this._renderer?.dispose?.()
    this._renderer?.forceContextLoss?.()
    if (this._container?.parentElement) this._container.parentElement.removeChild(this._container)
    this._container = null
    this._controlBar = null
    this._renderer = null
    this._scene = null
    this._camera = null
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
            title: 'Top-Down view (mirrors Foundry, aligned UI)',
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
            title: 'First Person (camera at the selected token; WASD to move — A/D strafe — scroll to turn)',
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
        const group = { name: 'cfg-3d', order: 95, title: '3D View', icon: 'fa-solid fa-cubes', visible: true, tools }
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

  /**
   * Create the WebGL renderer, preferring the high-performance (discrete) GPU
   * and trying a hardware-backed context first — falling back to software only
   * if no hardware GPU is available. Controlled by the "3D View — GPU" setting.
   */
  _createRenderer(THREE) {
    const powerPreference = this._gpuPreference()
    const opts = { antialias: true, alpha: true, powerPreference }
    if (powerPreference !== 'low-power') {
      try {
        const r = new THREE.WebGLRenderer({ ...opts, failIfMajorPerformanceCaveat: true })
        console.log('CFG Core | Overlay3D: hardware WebGL renderer')
        return r
      } catch (e) {
        console.warn('CFG Core | Overlay3D: no hardware GPU — using software WebGL.', e?.message || e)
      }
    }
    return new THREE.WebGLRenderer(opts)
  }

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
