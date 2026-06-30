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

    this._ground = null
    this._grid = null
    /** @type {any[]} extruded wall meshes */
    this._walls = []
    /** @type {any[]} map-note billboard markers */
    this._notes = []
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
      this._on('createNote', () => this._scheduleRebuild())
      this._on('updateNote', () => this._scheduleRebuild())
      this._on('deleteNote', () => this._scheduleRebuild())
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
        this._startLoop()
      } else {
        this._stopLoop()
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

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setSize(window.innerWidth, window.innerHeight)
    renderer.outputColorSpace = THREE.SRGBColorSpace
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

    scene.add(new THREE.HemisphereLight(0xffffff, 0x202830, 1.15))
    const sun = new THREE.DirectionalLight(0xffffff, 1.5)
    sun.position.set(0.5, 1, 0.3)
    scene.add(sun)

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

    const rect = this._sceneRect()
    const cx = rect.x + rect.width / 2
    const cz = rect.y + rect.height / 2

    this._buildGround(rect, cx, cz)
    this._buildGrid(rect, cx, cz)
    this._buildWalls()
    this._buildNotes()

    for (const tok of canvas.tokens?.placeables || []) this._addToken(tok)

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

  /** Apply the current camera mode: active camera, input routing, UI-hide. */
  _applyMode() {
    const orbit = this._mode === 'orbit'
    this._camera = orbit ? this._orbitCamera : this._trackedCamera
    if (this._controls) this._controls.enabled = orbit
    if (this._container) {
      // Tracked: let the mouse fall through to Foundry (pan/zoom/select) — the
      // camera follows. Orbit: capture events for OrbitControls.
      this._container.style.pointerEvents = orbit ? 'auto' : 'none'
    }
    // Orbit hides the misaligned 2D UI (option A); tracked lets it show (aligned).
    document.body.classList.toggle('cfg-3d-active', this._visible && orbit)
    if (orbit) this.setView('default')
    else this._syncTrackedCamera()
    this._render()
  }

  /**
   * Switch camera mode: 'tracked' (top-down, follows Foundry — UI aligns over
   * the 3D) or 'orbit' (free-look perspective — UI hidden).
   */
  setMode(mode) {
    mode = mode === 'orbit' ? 'orbit' : 'tracked'
    this._mode = mode
    if (this._mounted && this._visible) this._applyMode()
  }

  _buildGround(rect, cx, cz) {
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

  _buildGrid(rect, cx, cz) {
    const THREE = this._THREE
    const size = canvas?.dimensions?.size || 100
    const span = Math.max(rect.width, rect.height)
    const divisions = Math.max(1, Math.round(span / size))
    const grid = new THREE.GridHelper(span, divisions, 0x6688aa, 0x33445a)
    grid.position.set(cx, 0.5, cz)
    if (grid.material) {
      grid.material.transparent = true
      grid.material.opacity = 0.35
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
    const defaultHeightPx = (canvas?.dimensions?.size || 100) * 2
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
        const c = doc?.c
        if (!Array.isArray(c) || c.length < 4) continue
        const [x1, y1, x2, y2] = c
        const wh = doc.flags?.['wall-height'] || {}
        const bottom = Number.isFinite(wh.bottom) ? wh.bottom : 0
        const top = Number.isFinite(wh.top) ? wh.top : null
        const basePx = bottom * pxPerUnit
        const heightPx = top != null ? Math.max(1, (top - bottom) * pxPerUnit) : defaultHeightPx
        const dx = x2 - x1
        const dz = y2 - y1
        const len = Math.hypot(dx, dz)
        if (len < 1) continue
        const box = new THREE.Mesh(new THREE.BoxGeometry(len, heightPx, 6), this._wallMat)
        box.position.set((x1 + x2) / 2, basePx + heightPx / 2, (y1 + y2) / 2)
        box.rotation.y = -Math.atan2(dz, dx)
        this._scene.add(box)
        this._walls.push(box)
      } catch {
        /* skip a malformed wall */
      }
    }
  }

  /**
   * Render map note pins as flat billboard markers at their correct position.
   * Pins are UI on the map, not 3D geometry — so rather than hiding them under
   * the overlay, we float the pin icon just above the ground where the note
   * sits. (Other canvas markers — sound/light icons, templates — could be added
   * the same way.)
   */
  _buildNotes() {
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

  _addToken(tok) {
    try {
      const THREE = this._THREE
      const doc = tok.document
      if (!doc) return
      const { w, h } = this._tokenSizePx(doc)
      // Derive position from the document (not the placeable) so this is correct
      // both at full rebuild and mid-`updateToken`, when the placeable's
      // `.center` still holds the pre-move value.
      const center = { x: (doc.x || 0) + w / 2, y: (doc.y || 0) + h / 2 }
      const elevPx = (doc.elevation || 0) * this._pxPerUnit()
      const footprint = Math.max(w, h)

      const group = new THREE.Group()
      group.position.set(center.x, elevPx, center.y)

      // Footprint disc on the token's own elevation plane (helps read height).
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(footprint / 2, 32),
        new THREE.MeshBasicMaterial({
          color: dispositionColor(doc.disposition),
          transparent: true,
          opacity: 0.45,
          depthWrite: false,
        }),
      )
      disc.rotation.x = -Math.PI / 2
      disc.position.y = 0.5
      group.add(disc)

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

      // A thin "stalk" from the ground up to elevated tokens, so height reads.
      if (Math.abs(elevPx) > 1) {
        const stalk = new THREE.Mesh(
          new THREE.CylinderGeometry(2, 2, Math.abs(elevPx), 6),
          new THREE.MeshBasicMaterial({ color: 0xffc107, transparent: true, opacity: 0.5 }),
        )
        stalk.position.set(center.x, elevPx / 2, center.y)
        this._scene.add(stalk)
        group.userData.stalk = stalk
      }

      this._scene.add(group)
      this._tokens.set(tok.id, group)
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
      const tok = canvas?.tokens?.get?.(id)
      if (!tok) {
        this._scheduleRebuild()
        return
      }
      this._removeToken(id)
      this._addToken(tok)
      this._render()
    } catch {
      this._scheduleRebuild()
    }
  }

  /** Remove one token's 3D objects (group + height stalk) and dispose them. */
  _removeToken(id) {
    const group = this._tokens.get(id)
    if (!group) return
    const stalk = group.userData?.stalk
    if (stalk) {
      this._scene.remove(stalk)
      this._disposeObject(stalk)
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
    this._ready = false
  }

  destroy() {
    this._stopLoop()
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

  _registerControl() {
    const onChange = (event, active) => {
      // `active` reflects the toggle's new state in v13/v14.
      this.setVisible(active === undefined ? !this._visible : !!active)
    }
    this._on('getSceneControlButtons', (controls) => {
      try {
        const tool = {
          name: 'cfg-3d-overlay',
          title: 'Toggle 3D View',
          icon: 'fas fa-cube',
          order: 999,
          toggle: true,
          active: this._visible,
          onChange,
          // v12 compat (array shape) also reads onClick:
          onClick: (active) => this.setVisible(active === undefined ? !this._visible : !!active),
        }
        if (Array.isArray(controls)) {
          // v12 fallback: controls is an array, tools is an array
          const group = controls.find((c) => c?.name === 'token' || c?.name === 'tokens')
          if (group?.tools?.push) group.tools.push(tool)
          return
        }
        // v13/v14: controls is a Record, tools is a Record
        const group =
          controls.tokens ||
          controls.token ||
          Object.values(controls).find((c) => /token/i.test(c?.name || ''))
        if (group) {
          group.tools = group.tools || {}
          group.tools['cfg-3d-overlay'] = tool
        }
      } catch (err) {
        console.warn('CFG Core | Overlay3D control registration failed:', err)
      }
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
