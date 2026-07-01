/**
 * @crit-fumble vtt-viewer core — a framework-agnostic three.js scene renderer.
 *
 * ZERO Foundry / React / Next / Discord imports. `THREE` is INJECTED by the host so
 * the same core mounts into the Foundry plugin (its bundled three), the core web app /
 * PlayTable (vendored three), a bare iframe, or a Discord Activity — one renderer, a
 * thin per-surface data adapter that produces the normalized scene JSON below.
 *
 * Scene JSON (all coordinates in PIXELS; the adapter converts grid-units → px):
 *   {
 *     grid?:   { size:number },
 *     bounds?: { width:number, height:number },
 *     background?: { color?:number },
 *     tokens:  [{ id, x, y, width, height, elevation?, color?, texture? }],
 *   }
 * World mapping: scene x → world x, scene y → world z, elevation → world y (up).
 *
 * API: createViewer({ element, THREE, width?, height? }) →
 *   { loadScene(json), applyDelta(delta), getSceneGraph(), resize(w,h), render(), dispose(), scene, camera, renderer }
 */
export function createViewer({ element, THREE, width, height }) {
  if (!element) throw new Error('createViewer: `element` is required')
  if (!THREE) throw new Error('createViewer: inject `THREE` (the host provides its three build)')

  const w = width || element.clientWidth || 800
  const h = height || element.clientHeight || 600

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setSize(w, h, false)
  element.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, w / h, 1, 1e6)
  camera.up.set(0, 1, 0)

  scene.add(new THREE.AmbientLight(0xffffff, 0.75))
  const sun = new THREE.DirectionalLight(0xffffff, 0.8)
  sun.position.set(1, 2, 1.5)
  scene.add(sun)

  /** @type {Map<string, any>} tokenId → THREE.Group */
  const tokens = new Map()
  /** @type {any[]} extruded wall meshes */
  const walls = []
  let ground = null
  let bounds = { width: 2000, height: 2000 }

  function disposeObject(obj) {
    obj?.traverse?.((c) => {
      c.geometry?.dispose?.()
      const m = c.material
      if (Array.isArray(m)) m.forEach((x) => x?.dispose?.())
      else m?.dispose?.()
    })
  }

  function clear() {
    for (const g of tokens.values()) {
      scene.remove(g)
      disposeObject(g)
    }
    tokens.clear()
    for (const wl of walls) {
      scene.remove(wl)
      disposeObject(wl)
    }
    walls.length = 0
    if (ground) {
      scene.remove(ground)
      disposeObject(ground)
      ground = null
    }
  }

  /** A wall segment as a thin box extruded from `bottom` to `top`, aligned to the segment. */
  function addWall(wl) {
    const x1 = wl.x1 || 0
    const y1 = wl.y1 || 0
    const x2 = wl.x2 || 0
    const y2 = wl.y2 || 0
    const bottom = wl.bottom || 0
    const height = Math.max(1, (wl.top ?? bottom + 200) - bottom)
    const len = Math.max(1, Math.hypot(x2 - x1, y2 - y1))
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(len, height, 8),
      new THREE.MeshStandardMaterial({ color: wl.color ?? 0x8a8f98, roughness: 0.9 }),
    )
    mesh.position.set((x1 + x2) / 2, bottom + height / 2, (y1 + y2) / 2)
    mesh.rotation.y = -Math.atan2(y2 - y1, x2 - x1) // align the box length with the segment (world XZ)
    scene.add(mesh)
    walls.push(mesh)
  }

  function addToken(t) {
    const group = new THREE.Group()
    const cx = (t.x || 0) + (t.width || 0) / 2
    const cz = (t.y || 0) + (t.height || 0) / 2
    group.position.set(cx, t.elevation || 0, cz)
    group.userData = { tokenId: t.id }
    const box = new THREE.Mesh(
      new THREE.BoxGeometry((t.width || 50) * 0.8, 40, (t.height || 50) * 0.8),
      new THREE.MeshStandardMaterial({ color: t.color ?? 0x6a90c0, roughness: 0.8 }),
    )
    box.position.y = 20 // stand on the token's elevation plane
    group.add(box)
    scene.add(group)
    tokens.set(t.id, group)
  }

  /** Frame the whole scene from an angled bird's-eye so a load is visible without setup. */
  function frameCamera() {
    const cx = bounds.width / 2
    const cz = bounds.height / 2
    const span = Math.max(bounds.width, bounds.height)
    camera.position.set(cx, span * 0.9, cz + span * 0.75)
    camera.lookAt(cx, 0, cz)
    camera.updateProjectionMatrix()
  }

  function loadScene(json) {
    clear()
    bounds = json?.bounds || bounds
    scene.background = json?.background?.color != null ? new THREE.Color(json.background.color) : null
    const g = new THREE.Mesh(
      new THREE.PlaneGeometry(bounds.width, bounds.height),
      new THREE.MeshStandardMaterial({ color: 0x2a3340, roughness: 0.95 }),
    )
    g.rotation.x = -Math.PI / 2
    g.position.set(bounds.width / 2, 0, bounds.height / 2)
    scene.add(g)
    ground = g
    for (const t of json?.tokens || []) addToken(t)
    for (const wl of json?.walls || []) addWall(wl)
    frameCamera()
    render()
  }

  /** Incremental update — move/add/remove tokens without a full reload. */
  function applyDelta(delta) {
    for (const t of delta?.tokens || []) {
      if (t.remove) {
        const g = tokens.get(t.id)
        if (g) {
          scene.remove(g)
          disposeObject(g)
          tokens.delete(t.id)
        }
        continue
      }
      const g = tokens.get(t.id)
      if (g) {
        const cx = (t.x || 0) + (t.width || 0) / 2
        const cz = (t.y || 0) + (t.height || 0) / 2
        g.position.set(cx, t.elevation || 0, cz)
      } else {
        addToken(t)
      }
    }
    render()
  }

  function getSceneGraph() {
    return {
      tokenCount: tokens.size,
      wallCount: walls.length,
      hasGround: !!ground,
      tokens: [...tokens.entries()].map(([id, g]) => ({ id, pos: [Math.round(g.position.x), Math.round(g.position.y), Math.round(g.position.z)] })),
      walls: walls.map((w) => ({ pos: [Math.round(w.position.x), Math.round(w.position.y), Math.round(w.position.z)], height: Math.round(w.geometry.parameters.height) })),
    }
  }

  function resize(nw, nh) {
    const ww = nw || element.clientWidth || w
    const hh = nh || element.clientHeight || h
    renderer.setSize(ww, hh, false)
    camera.aspect = ww / hh
    camera.updateProjectionMatrix()
    render()
  }

  function render() {
    renderer.render(scene, camera)
  }

  function dispose() {
    clear()
    renderer.dispose()
    if (renderer.domElement?.parentNode === element) element.removeChild(renderer.domElement)
  }

  return { loadScene, applyDelta, getSceneGraph, resize, render, dispose, scene, camera, renderer }
}
