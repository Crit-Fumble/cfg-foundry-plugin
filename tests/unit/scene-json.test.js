/**
 * buildWallsJson — the Foundry→viewer wall producer, tested WITHOUT a live Foundry.
 *
 * This is the concrete payoff of the overlay-3d.js decomposition: the wall-shaping
 * logic (secret-door security, door/window classification, native restriction nodes,
 * the custom texture/tint flag, slice-ceiling clipping) is now a pure function with
 * an explicit `ctx`, so it locks in milliseconds instead of a 2-minute Playwright run.
 */
import {
  buildWallsJson,
  buildGridJson,
  buildTilesJson,
  buildNotesJson,
  buildTokenJson,
  buildLightsJson,
  buildLevelsJson,
  buildRegionsJson,
  buildTerrainJson,
  dispositionColor,
  levelsElevation,
  parseHexColor,
  levelBase,
  levelTop,
  levelContainingElevation,
  resolveActiveLevel,
} from '../../scripts/services/overlay3d/scene-json.js'

const ctx = {
  pxPerUnit: 20,
  ceilUnits: null,
  docInSlice: () => true,
  wallBand: () => ({ bottom: 0, top: 5 }),
  assetUrl: (s) => `ABS:${s}`,
}
const wall = (over) => ({ id: 'w', c: [0, 0, 100, 0], door: 0, ds: 0, dir: 0, light: 20, sight: 20, move: 20, flags: {}, ...over })
const kindOf = (over, c = ctx) => buildWallsJson([wall(over)], c)[0]?.kind

describe('buildWallsJson', () => {
  it('shapes a plain wall + height in px', () => {
    const [w] = buildWallsJson([wall()], ctx)
    expect(w.kind).toBe('wall')
    expect(w.bottom).toBe(0)
    expect(w.top).toBe(100) // 5 units × 20 px/unit
    expect(w.opacity).toBe(0.85)
  })

  it('SECURITY: a CLOSED or LOCKED secret door is an indistinguishable wall', () => {
    expect(kindOf({ door: 2, ds: 0 })).toBe('wall') // closed
    expect(kindOf({ door: 2, ds: 2 })).toBe('wall') // locked
  })

  it('an OPENED secret door is revealed as a door; a normal door is a door', () => {
    expect(kindOf({ door: 2, ds: 1 })).toBe('door')
    expect(kindOf({ door: 1, ds: 0 })).toBe('door')
  })

  it('classifies a window (blocks movement, not sight)', () => {
    expect(kindOf({ door: 0, move: 20, sight: 0 })).toBe('window')
    // a secret door must never be mistaken for a window
    expect(kindOf({ door: 2, ds: 0, move: 20, sight: 0 })).toBe('wall')
  })

  it('exposes the native restriction nodes', () => {
    const [w] = buildWallsJson([wall({ dir: 1, light: 0, sight: 0 })], ctx)
    expect(w.dir).toBe(1)
    expect(w.blocksLight).toBe(false)
    expect(w.blocksSight).toBe(false)
  })

  it('base texture: our flag drives the render, native animation.texture is only a fallback', () => {
    // our flag wins over Foundry's animation.texture (any kind)
    expect(buildWallsJson([wall({ flags: { 'crit-fumble-core': { texture: 'flag.png' } }, animation: { texture: 'anim.png' } })], ctx)[0].texture).toBe('ABS:flag.png')
    // no flag → fall back to the native door texture (a door with Foundry's Door Texture set)
    expect(buildWallsJson([wall({ door: 1, ds: 0, animation: { texture: 'anim.png' } })], ctx)[0].texture).toBe('ABS:anim.png')
    // a plain wall with only our flag (Foundry can't persist animation for non-doors)
    expect(buildWallsJson([wall({ flags: { 'crit-fumble-core': { texture: 'wall.png' } } })], ctx)[0].texture).toBe('ABS:wall.png')
    // neither → no texture
    expect(buildWallsJson([wall()], ctx)[0].texture).toBeUndefined()
  })

  it('flip: flag first, animation fallback (needs a texture to mirror); door swing/double/type still from native animation', () => {
    expect(buildWallsJson([wall({ flags: { 'crit-fumble-core': { texture: 'w.png', flip: true } } })], ctx)[0].flip).toBe(true)
    expect(buildWallsJson([wall({ door: 1, animation: { texture: 'a.png', flip: true } })], ctx)[0].flip).toBe(true)
    const [d] = buildWallsJson([wall({ door: 1, ds: 0, animation: { double: true, direction: -1, type: 'slide' } })], ctx)
    expect(d).toMatchObject({ kind: 'door', double: true, swingDir: -1, animType: 'slide' })
  })

  it('tiles a textured wall by default (one tile per grid cell), scaled by tileScale', () => {
    // 100px-long wall, 100px tall (5u×20), gridSize 100 → 1 tile per cell by default
    const [w] = buildWallsJson([wall({ flags: { 'crit-fumble-core': { texture: 't.png' } } })], { ...ctx, gridSize: 100 })
    expect(w).toMatchObject({ texture: 'ABS:t.png', tileX: 1, tileY: 1 })
    // tileScale 2 → twice as many (smaller) tiles on both axes
    const [w2] = buildWallsJson([wall({ flags: { 'crit-fumble-core': { texture: 't.png', tileScale: 2 } } })], { ...ctx, gridSize: 100 })
    expect(w2).toMatchObject({ tileX: 2, tileY: 2 })
    // smaller grid (50px) → the same wall spans more cells → more tiles
    const [w3] = buildWallsJson([wall({ flags: { 'crit-fumble-core': { texture: 't.png' } } })], { ...ctx, gridSize: 50 })
    expect(w3).toMatchObject({ tileX: 2, tileY: 2 })
  })

  it('no texture → optional flat wall colour from the flag (no color = default palette)', () => {
    expect(buildWallsJson([wall({ flags: { 'crit-fumble-core': { color: '#ff8800' } } })], ctx)[0].color).toBe(0xff8800)
    expect(buildWallsJson([wall()], ctx)[0].color).toBeUndefined()
    // a texture wins over colour: textured wall carries no flat colour
    const [w] = buildWallsJson([wall({ flags: { 'crit-fumble-core': { texture: 't.png', color: '#ff8800' } } })], ctx)
    expect(w.texture).toBe('ABS:t.png')
    expect(w.color).toBeUndefined()
  })

  it('scene/level 3D defaults cascade: own flag wins, native door texture next, then the default', () => {
    const withDflt = (d, over) => buildWallsJson([wall(over)], { ...ctx, gridSize: 100, wall3dDefaults: () => d })[0]
    // no own texture → the resolved default texture applies (and tiles)
    expect(withDflt({ texture: 'lvl.png' }, {})).toMatchObject({ texture: 'ABS:lvl.png', tileX: 1, tileY: 1 })
    // the wall's OWN flag texture beats the default
    expect(withDflt({ texture: 'lvl.png' }, { flags: { 'crit-fumble-core': { texture: 'own.png' } } }).texture).toBe('ABS:own.png')
    // a door's native texture beats the default too
    expect(withDflt({ texture: 'lvl.png' }, { door: 1, animation: { texture: 'nat.png' } }).texture).toBe('ABS:nat.png')
    // default tileScale used when the wall has a texture but no own scale
    expect(withDflt({ tileScale: 2 }, { flags: { 'crit-fumble-core': { texture: 'own.png' } } })).toMatchObject({ tileX: 2, tileY: 2 })
    // a BLANK own tileScale inherits the default (not shadow it with 1)
    expect(withDflt({ tileScale: 3 }, { flags: { 'crit-fumble-core': { texture: 'own.png', tileScale: '' } } })).toMatchObject({ tileX: 3, tileY: 3 })
    // default colour applies to an untextured wall; a texture default would instead win
    expect(withDflt({ color: '#00ff00' }, {}).color).toBe(0x00ff00)
    // the wall's own colour beats the default colour
    expect(withDflt({ color: '#00ff00' }, { flags: { 'crit-fumble-core': { color: '#0000ff' } } }).color).toBe(0x0000ff)
  })

  it('clips a tall wall to the slice ceiling', () => {
    const [w] = buildWallsJson([wall()], { ...ctx, ceilUnits: 3 })
    expect(w.top).toBe(60) // min(5,3) × 20
  })

  it('skips out-of-slice, degenerate, and malformed walls', () => {
    expect(buildWallsJson([wall()], { ...ctx, docInSlice: () => false })).toHaveLength(0)
    expect(buildWallsJson([wall({ c: [0, 0, 0.5, 0] })], ctx)).toHaveLength(0) // len < 1
    expect(buildWallsJson([wall({ c: null })], ctx)).toHaveLength(0)
    expect(buildWallsJson([null], ctx)).toHaveLength(0)
    expect(buildWallsJson(undefined, ctx)).toHaveLength(0)
  })
})

describe('parseHexColor', () => {
  it('parses hex strings, numbers, and falls back on junk', () => {
    expect(parseHexColor('#99aabb', 0)).toBe(0x99aabb)
    expect(parseHexColor(0x123456, 0)).toBe(0x123456)
    expect(parseHexColor(null, 0xcccccc)).toBe(0xcccccc)
    expect(parseHexColor('', 0xcccccc)).toBe(0xcccccc)
  })
})

describe('buildGridJson', () => {
  it('mirrors Foundry grid colour (hex string) + alpha floor', () => {
    expect(buildGridJson({ type: 1, color: '#999999', alpha: 0.1 }, 100)).toEqual({ size: 100, showHelper: true, color: 0x999999, opacity: 0.25 })
  })
  it('gridless (type 0) → no helper; default grey when unset', () => {
    expect(buildGridJson({ type: 0 }, 100).showHelper).toBe(false)
    expect(buildGridJson({ type: 2 }, 100).color).toBe(0xcccccc)
  })
})

describe('dispositionColor', () => {
  it('maps friendly/hostile/secret/neutral', () => {
    expect(dispositionColor(1)).toBe(0x4caf50)
    expect(dispositionColor(-1)).toBe(0xf44336)
    expect(dispositionColor(-2)).toBe(0x9c27b0)
    expect(dispositionColor(0)).toBe(0x2196f3)
  })
})

describe('levelsElevation', () => {
  it('prefers the Levels rangeBottom, else elevation', () => {
    expect(levelsElevation({ flags: { levels: { rangeBottom: 20 } }, elevation: 5 })).toBe(20)
    expect(levelsElevation({ elevation: 5 })).toBe(5)
    expect(levelsElevation({})).toBe(0)
  })
})

describe('levelBase / levelTop (Foundry null-band contract)', () => {
  it('base: finite base wins, else bottom, else null-bottom = min(top,0) NOT 0', () => {
    expect(levelBase({ elevation: { base: 5, bottom: null } })).toBe(5) // derived base wins
    expect(levelBase({ elevation: { bottom: 3 } })).toBe(3)
    expect(levelBase({ elevation: { bottom: null, top: -10 } })).toBe(-10) // open bottom, below-ground top
    expect(levelBase({ elevation: { bottom: null, top: 20 } })).toBe(0) // open bottom, above-ground → min(20,0)=0
    expect(levelBase({ elevation: { bottom: null, top: null } })).toBe(0)
    expect(levelBase({})).toBe(0)
  })
  it('top: finite top, else null/absent = +Infinity', () => {
    expect(levelTop({ elevation: { top: 15 } })).toBe(15)
    expect(levelTop({ elevation: { top: null } })).toBe(Infinity)
    expect(levelTop({})).toBe(Infinity)
  })
})

describe('levelContainingElevation', () => {
  const G = { id: 'g', elevation: { bottom: 0, top: 10 } }
  const U = { id: 'u', elevation: { bottom: 10, top: 20 } }
  const B = { id: 'b', elevation: { bottom: -10, top: 0 } }
  const levels = [B, G, U]
  it('maps an elevation to its half-open [base,top) band; boundary belongs to the upper floor', () => {
    expect(levelContainingElevation(levels, 0)?.id).toBe('g') // floor of ground
    expect(levelContainingElevation(levels, 5)?.id).toBe('g')
    expect(levelContainingElevation(levels, 10)?.id).toBe('u') // shared boundary → upper
    expect(levelContainingElevation(levels, 15)?.id).toBe('u')
    expect(levelContainingElevation(levels, -5)?.id).toBe('b')
    expect(levelContainingElevation(levels, 99)).toBeNull() // above every band
    expect(levelContainingElevation(levels, NaN)).toBeNull()
  })
})

describe('resolveActiveLevel', () => {
  const A = { id: 'A', elevation: { bottom: 0 } }
  const B = { id: 'B', elevation: { bottom: 50 } }
  const C = { id: 'C', elevation: { bottom: 20 } }
  const get = (id) => ({ A, B, C }[id] || null)
  it('firstperson: the SUBJECT floor wins over focus-follow AND canvas.level', () => {
    expect(resolveActiveLevel({ mode: 'firstperson', get, firstPersonLevelId: 'B', focusFollow: true, focusLevelId: 'A', canvasLevel: C, viewLevelId: 'A' }).id).toBe('B')
  })
  it('firstperson with no resolvable subject falls through to the legacy chain', () => {
    expect(resolveActiveLevel({ mode: 'firstperson', get, firstPersonLevelId: undefined, focusFollow: false, canvasLevel: C }).id).toBe('C')
  })
  it('non-firstperson keeps legacy precedence: focus-follow → canvas.level → view → topmost', () => {
    expect(resolveActiveLevel({ mode: 'orbit', get, firstPersonLevelId: 'B', focusFollow: true, focusLevelId: 'A', canvasLevel: C }).id).toBe('A')
    expect(resolveActiveLevel({ mode: 'orbit', get, focusFollow: false, canvasLevel: C }).id).toBe('C')
    expect(resolveActiveLevel({ mode: 'tracked', get, focusFollow: false, canvasLevel: null, viewLevelId: 'zzz', allLevels: [A, B, C], levelBase }).id).toBe('B') // topmost base=50
  })
})

describe('buildRegionsJson', () => {
  const rctx = { pxPerUnit: 20 }
  const reg = (o) => ({ id: 'r', surface: 10, base: 0, vertices: [0, 0, 100, 0, 100, 100], indices: [0, 1, 2], rings: [[0, 0, 100, 0, 100, 100]], color: 0x00ff00, ...o })
  it('scales surface/base to px and passes native triangulation + rings through', () => {
    const [r] = buildRegionsJson([reg()], rctx)
    expect(r).toMatchObject({ id: 'r', elevation: 200, base: 0, vertices: [0, 0, 100, 0, 100, 100], indices: [0, 1, 2], color: 0x00ff00 })
    expect(r.rings).toEqual([[0, 0, 100, 0, 100, 100]])
  })
  it('base defaults to 0 when absent; a sunken surface scales negative', () => {
    expect(buildRegionsJson([reg({ base: undefined })], rctx)[0].base).toBe(0)
    expect(buildRegionsJson([reg({ surface: -5 })], rctx)[0].elevation).toBe(-100)
  })
  it('drops regions without a finite surface or usable geometry', () => {
    expect(buildRegionsJson([reg({ surface: null })], rctx)).toHaveLength(0)
    expect(buildRegionsJson([reg({ surface: NaN })], rctx)).toHaveLength(0)
    expect(buildRegionsJson([reg({ vertices: [] })], rctx)).toHaveLength(0)
    expect(buildRegionsJson([reg({ indices: [] })], rctx)).toHaveLength(0)
    expect(buildRegionsJson([null], rctx)).toHaveLength(0)
    expect(buildRegionsJson(undefined, rctx)).toHaveLength(0)
  })
})

describe('buildTerrainJson', () => {
  const ctx = { pxPerUnit: 20, src: 'ABS:map.jpg' }
  it('scales heights (units → px) and passes the grid + draped src through', () => {
    const t = buildTerrainJson({ cols: 2, rows: 2, heights: [0, 5, -2, 10] }, ctx)
    expect(t).toEqual({ cols: 2, rows: 2, heights: [0, 100, -40, 200], src: 'ABS:map.jpg', color: undefined })
  })
  it('returns null when absent or degenerate (keeps the flat floor)', () => {
    expect(buildTerrainJson(null, ctx)).toBeNull()
    expect(buildTerrainJson({ cols: 1, rows: 5, heights: [] }, ctx)).toBeNull() // cols < 2
    expect(buildTerrainJson({ cols: 3, rows: 3, heights: [1, 2, 3] }, ctx)).toBeNull() // too few heights
    expect(buildTerrainJson({ cols: 2, rows: 2 }, ctx)).toBeNull() // no heights
  })
  it('coerces non-finite cells to 0', () => {
    expect(buildTerrainJson({ cols: 2, rows: 2, heights: [1, null, 'x', 3] }, ctx).heights).toEqual([20, 0, 0, 60])
  })
})

describe('buildTilesJson', () => {
  const tctx = { pxPerUnit: 20, docInSlice: () => true, assetUrl: (s) => `ABS:${s}` }
  const tile = (o) => ({ id: 't', x: 10, y: 20, width: 100, height: 100, alpha: 0.5, texture: { src: 'floor.png' }, elevation: 0, ...o })
  it('shapes a tile at its floor elevation', () => {
    const [t] = buildTilesJson([tile()], tctx)
    expect(t).toMatchObject({ id: 't', x: 10, y: 20, width: 100, height: 100, elevation: 0, texture: 'ABS:floor.png', alpha: 0.5, color: 0x515b6b })
  })
  it('tints raised floors + skips hidden/tiny/out-of-slice', () => {
    expect(buildTilesJson([tile({ elevation: 10, flags: { levels: { rangeBottom: 10 } }, texture: {} })], tctx)[0].color).toBe(0x7a6a52)
    expect(buildTilesJson([tile({ hidden: true })], tctx)).toHaveLength(0)
    expect(buildTilesJson([tile({ width: 0 })], tctx)).toHaveLength(0)
    expect(buildTilesJson([tile()], { ...tctx, docInSlice: () => false })).toHaveLength(0)
  })
})

describe('buildNotesJson', () => {
  it('uses the placeable centre, falls back to doc x/y', () => {
    const [n] = buildNotesJson([{ center: { x: 5, y: 6 }, document: { id: 'n', iconSize: 40, texture: { src: 'pin.png' } } }], (s) => `ABS:${s}`)
    expect(n).toEqual({ id: 'n', x: 5, y: 6, size: 40, texture: 'ABS:pin.png' })
  })
})

describe('buildTokenJson', () => {
  const kctx = { pxPerUnit: 20, sizePx: { w: 100, h: 100 }, floorElevation: 40, assetUrl: (s) => `ABS:${s}` }
  it('shapes a token (size, elevation×pxPerUnit, floor, disposition, texture, model flags)', () => {
    const doc = { id: 'k', x: 1, y: 2, elevation: 3, disposition: -1, texture: { src: 'k.png' }, flags: { 'crit-fumble-core': { modelSrc: 'k.glb', modelScale: 2 } } }
    expect(buildTokenJson(doc, kctx)).toEqual({
      id: 'k', x: 1, y: 2, width: 100, height: 100, elevation: 60, floorElevation: 40,
      color: 0xf44336, texture: 'ABS:k.png', model: 'ABS:k.glb', modelScale: 2, modelRotation: undefined,
    })
  })
  it('lifts elevation by the terrain ground offset so a ground token sits ON the surface', () => {
    const doc = { id: 'k', x: 0, y: 0, elevation: 0, flags: {} }
    // ground token on +8u terrain (floor 160px): renders at (0+8)*20 = 160, flush with its floor
    expect(buildTokenJson(doc, { ...kctx, floorElevation: 160, groundOffsetUnits: 8 })).toMatchObject({ elevation: 160, floorElevation: 160 })
    // a flying token keeps its height above the surface
    expect(buildTokenJson({ ...doc, elevation: 5 }, { ...kctx, floorElevation: 160, groundOffsetUnits: 8 }).elevation).toBe(260) // (5+8)*20
  })
})

describe('buildLightsJson', () => {
  const lctx = (over = {}) => ({
    env: { daylight: 0xeeeeee, darkCol: 0x303030, brightest: 0xffffff, darkness: 0, globalLightOn: false, ...over.env },
    size: 100,
    shadows: false,
    pxPerUnit: 20,
    docInSlice: () => true,
    tokenSizePx: () => ({ w: 100, h: 100 }),
    ...over,
  })
  it('full daylight → bright ambient + full floorBrightness ("3D too dark" fix)', () => {
    const { ambient } = buildLightsJson([], [], lctx())
    expect(ambient.hemisphere.intensity).toBeCloseTo(1.5) // 0.6 + 0.9×1
    expect(ambient.floorBrightness).toBeCloseTo(0.95) // 0.55 + 0.4×1
  })
  it('dark scene dims ambient + floor; globalLight overrides darkness', () => {
    expect(buildLightsJson([], [], lctx({ env: { darkness: 1 } })).ambient.floorBrightness).toBeCloseTo(0.55)
    expect(buildLightsJson([], [], lctx({ env: { darkness: 1, globalLightOn: true } })).ambient.floorBrightness).toBeCloseTo(0.95)
  })
  it('shapes AmbientLight placeables into point lights (radius = max(dim,bright)×pxPerUnit)', () => {
    const { lights } = buildLightsJson([{ config: { dim: 6, bright: 3, color: 0xff8800 }, x: 100, y: 200, elevation: 0 }], [], lctx())
    expect(lights).toHaveLength(1)
    expect(lights[0]).toMatchObject({ x: 100, y: 200, color: 0xff8800, radius: 120 })
  })
  it('skips dark / hidden / out-of-slice lights', () => {
    expect(buildLightsJson([{ config: { dim: 0, bright: 0 }, x: 0, y: 0 }], [], lctx()).lights).toHaveLength(0)
    expect(buildLightsJson([{ hidden: true, config: { dim: 6 }, x: 0, y: 0 }], [], lctx()).lights).toHaveLength(0)
    expect(buildLightsJson([{ config: { dim: 6 }, x: 0, y: 0 }], [], lctx({ docInSlice: () => false })).lights).toHaveLength(0)
  })
  it('caps shadow-casting point lights at 4', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ config: { dim: 6 }, x: i, y: 0, elevation: 0 }))
    expect(buildLightsJson(many, [], lctx({ shadows: true })).lights.filter((l) => l.castShadow)).toHaveLength(4)
  })
})

describe('buildLevelsJson', () => {
  const baseCtx = {
    levelElevPx: (level, which) => (which === 'top' ? (level.elevation?.top ?? 0) : (level.elevation?.bottom ?? 0)) * 10,
    assetUrl: (s) => `ABS:${s}`,
    sliceCut: () => 100,
    levelBase: (level) => level.elevation?.bottom ?? 0,
    activeLevel: () => null,
    userCanSeeLevel: () => true,
    backgroundSrc: () => null,
  }
  const lctx = (over) => ({ ...baseCtx, ...over })
  const lvl = (o) => ({ sort: 0, elevation: { bottom: 0, top: 10 }, background: { src: 'bg.png' }, foreground: null, textures: {}, ...o })

  it('emits a background quad per visible level, sorted by `sort`', () => {
    const out = buildLevelsJson([lvl({ sort: 2, background: { src: 'b.png' } }), lvl({ sort: 1, background: { src: 'a.png' } })], lctx())
    expect(out.map((q) => q.src)).toEqual(['ABS:a.png', 'ABS:b.png']) // stable sort by `sort`
    expect(out[0]).toMatchObject({ which: 'bottom', elevation: 0, alphaTest: 0.75 })
  })

  it('clips floors above the slice cut', () => {
    const out = buildLevelsJson([lvl(), lvl({ elevation: { bottom: 200 }, background: { src: 'high.png' } })], lctx())
    expect(out.map((q) => q.src)).toEqual(['ABS:bg.png']) // the bottom-200 floor is above cut 100
  })

  it('skips levels the player cannot see + video backgrounds', () => {
    expect(buildLevelsJson([lvl()], lctx({ userCanSeeLevel: () => false }))).toHaveLength(0)
    expect(buildLevelsJson([lvl({ background: { src: 'movie.webm' } })], lctx())).toHaveLength(0)
  })

  it('adds the foreground/roof only for floors strictly below the active one', () => {
    const ground = lvl({ elevation: { bottom: 0 }, foreground: { src: 'roof.png' } })
    const out = buildLevelsJson([ground], lctx({ activeLevel: () => ({ elevation: { bottom: 100 } }), sliceCut: () => 1000 }))
    expect(out.map((q) => q.which)).toEqual(['bottom', 'top']) // below active → roof shows
    // the active floor itself gets no roof
    expect(buildLevelsJson([lvl({ elevation: { bottom: 100 }, foreground: { src: 'roof.png' } })], lctx({ activeLevel: () => ({ elevation: { bottom: 100 } }), sliceCut: () => 1000 })).map((q) => q.which)).toEqual(['bottom'])
  })

  it('true first-person: draws the active level OWN ceiling; other modes never do', () => {
    const A = lvl({ elevation: { bottom: 100, top: 120 }, background: { src: 'g.png' }, foreground: { src: 'roof.png' } })
    const fpCtx = lctx({ firstPerson: true, activeLevel: () => A, levelVisibleFromActive: () => false, sliceCut: () => Infinity })
    expect(buildLevelsJson([A], fpCtx).map((q) => q.which)).toEqual(['bottom', 'top']) // own ceiling overhead
    // same scene NOT true-FP → cutaway never draws the active roof
    expect(buildLevelsJson([A], lctx({ activeLevel: () => A, sliceCut: () => Infinity })).map((q) => q.which)).toEqual(['bottom'])
  })

  it('true first-person: no ceiling on an open-top (null) active level', () => {
    const A = lvl({ elevation: { bottom: 100, top: null }, foreground: { src: 'roof.png' } })
    expect(buildLevelsJson([A], lctx({ firstPerson: true, activeLevel: () => A, levelVisibleFromActive: () => false, sliceCut: () => Infinity })).map((q) => q.which)).toEqual(['bottom'])
  })

  it('true first-person: shows only active + authored visible-through floors (availableLevels wins)', () => {
    const A = lvl({ elevation: { bottom: 100, top: 120 }, background: { src: 'a.png' } }) // active
    const U = lvl({ elevation: { bottom: 200, top: 220 }, background: { src: 'u.png' } }) // authored visible-through
    const O = lvl({ elevation: { bottom: 300, top: 320 }, background: { src: 'o.png' } }) // not visible
    const ctx = lctx({ firstPerson: true, activeLevel: () => A, levelVisibleFromActive: (l) => l === U, sliceCut: () => Infinity })
    expect(buildLevelsJson([A, U, O], ctx).map((q) => q.src)).toEqual(['ABS:a.png', 'ABS:u.png']) // O hidden
    // player availableLevels gate still wins over authored visibility
    expect(buildLevelsJson([A, U, O], lctx({ firstPerson: true, activeLevel: () => A, levelVisibleFromActive: () => true, userCanSeeLevel: () => false }))).toHaveLength(0)
  })

  it('true first-person: a visible-through floor BELOW active still shows its roof (seen down)', () => {
    const A = lvl({ elevation: { bottom: 100, top: 120 }, background: { src: 'a.png' } })
    const B = lvl({ elevation: { bottom: 0, top: 10 }, background: { src: 'b.png' }, foreground: { src: 'roof.png' } })
    const ctx = lctx({ firstPerson: true, activeLevel: () => A, levelVisibleFromActive: (l) => l === B, sliceCut: () => Infinity })
    expect(buildLevelsJson([A, B], ctx).map((q) => `${q.which}:${q.src}`)).toEqual(['bottom:ABS:a.png', 'bottom:ABS:b.png', 'top:ABS:roof.png'])
  })

  it('falls back to the scene background quad when there are no levels', () => {
    expect(buildLevelsJson([], lctx({ backgroundSrc: () => 'scene.png' }))).toEqual([{ elevation: 0, which: 'bottom', src: 'ABS:scene.png', alphaTest: 0 }])
    expect(buildLevelsJson([], lctx())).toHaveLength(0) // no levels, no bg → empty
  })

  it('converts tint (skips white) + rotation (deg → negative rad)', () => {
    const [q] = buildLevelsJson([lvl({ background: { src: 'b.png', tint: 0xff0000 }, textures: { rotation: 90 } })], lctx())
    expect(q.tint).toBe(0xff0000)
    expect(q.rotation).toBeCloseTo(-Math.PI / 2)
    expect(buildLevelsJson([lvl({ background: { src: 'b.png', tint: 0xffffff } })], lctx())[0].tint).toBeUndefined()
  })
})
