/**
 * adapter-foundry — convert a FoundryVTT Scene (doc or plain stored JSON) into the
 * framework-agnostic viewer core's normalized scene JSON. PURE: no Foundry runtime, no
 * three, no DOM — just data in, data out. This is the "thin per-surface adapter" that
 * lets the shared viewer render the exact same file data the Foundry plugin uses, from
 * PlayTable / a bare iframe / offline, without a live server.
 *
 * Foundry conventions handled:
 *  - grid.size = px per cell; grid.distance = world units per cell → pxPerUnit for elevation.
 *  - Token x/y = top-left px; width/height in GRID UNITS → px (× grid.size); elevation in
 *    distance-units (e.g. ft) → px (× pxPerUnit).
 *  - Wall c = [x1,y1,x2,y2] px; optional flags["wall-height"].{bottom,top} in distance units.
 *  - disposition (1 friendly / 0 neutral / -1 hostile) → a tint colour.
 */

/** Foundry disposition → token tint (friendly green / neutral amber / hostile red). */
export function dispositionColor(d) {
  if (d === 1) return 0x4caf50
  if (d === -1) return 0xe53935
  return 0xffb300
}

/** Parse a Foundry colour ("#223044" or a number) to a numeric colour, or null. */
function parseColor(c) {
  if (typeof c === 'number') return c
  if (typeof c === 'string' && c[0] === '#') return parseInt(c.slice(1), 16)
  return null
}

export function foundrySceneToViewer(scene = {}) {
  const grid = scene.grid || {}
  const gridSize = Number(grid.size) || 100
  const distance = Number(grid.distance) || 5
  const pxPerUnit = distance ? gridSize / distance : gridSize / 5
  const width = Number(scene.width ?? scene.dimensions?.width) || 2000
  const height = Number(scene.height ?? scene.dimensions?.height) || 2000

  const toArray = (v) => (Array.isArray(v) ? v : v?.contents || [])

  const tokens = toArray(scene.tokens).map((t) => ({
    id: t.id ?? t._id,
    x: Number(t.x) || 0,
    y: Number(t.y) || 0,
    width: (Number(t.width) || 1) * gridSize, // grid units → px
    height: (Number(t.height) || 1) * gridSize,
    elevation: (Number(t.elevation) || 0) * pxPerUnit, // distance units → px
    texture: t.texture?.src || null,
    color: dispositionColor(t.disposition),
  }))

  const walls = toArray(scene.walls).map((w) => {
    const c = w.c || []
    const wh = w.flags?.['wall-height'] || {}
    const bottom = Number.isFinite(wh.bottom) ? wh.bottom * pxPerUnit : 0
    const top = Number.isFinite(wh.top) ? wh.top * pxPerUnit : bottom + gridSize * 2 // default: 2 grids tall
    return { id: w.id ?? w._id, x1: c[0] || 0, y1: c[1] || 0, x2: c[2] || 0, y2: c[3] || 0, bottom, top }
  })

  const background = {}
  const bg = parseColor(scene.backgroundColor)
  if (bg != null) background.color = bg

  return { grid: { size: gridSize }, bounds: { width, height }, background, tokens, walls }
}
