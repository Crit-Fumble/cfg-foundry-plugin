/**
 * Foundry → viewer scene-JSON producers, extracted from overlay-3d.js as PURE
 * functions so they're unit-testable without a live Foundry (the whole point of the
 * decomposition). The FRAMEWORK CONTRACT is the returned JSON shape (`ViewerScene.*`)
 * that the shared vtt-viewer core renders; a host provides the small `ctx` of data
 * accessors. This file is the Foundry adapter's producer layer — no THREE, no viewer.
 *
 * As more builders (`buildLightsJson`, `buildGridJson`, `buildTilesJson`, …) are lifted
 * here the same way, `overlay-3d.js` shrinks toward thin lifecycle + interaction glue.
 */

/** Foundry CONST.TOKEN_DISPOSITIONS → a tint for placeholder/footprint marks. Mirrors
 * Token#getDispositionColor (client/canvas/placeables/token.mjs) exactly, including the
 * FRIENDLY/PARTY split by actor ownership. `colors` should be CONFIG.Canvas.dispositionColors
 * from the live client; the numbers below are its own defaults, used as a fallback only
 * (e.g. a headless test, or a module that hasn't populated CONFIG yet). */
export function dispositionColor(disposition, hasPlayerOwner, colors) {
  const c = colors || {}
  switch (disposition) {
    case 1: // FRIENDLY
      return (hasPlayerOwner ? c.PARTY : c.FRIENDLY) ?? (hasPlayerOwner ? 0x33bc4e : 0x43dfdf)
    case -1: // HOSTILE
      return c.HOSTILE ?? 0xe72124
    case -2: // SECRET
      return c.SECRET ?? 0xa612d4
    case 0: // NEUTRAL
      return c.NEUTRAL ?? 0xf1d836
    default: // INACTIVE (out-of-range / no disposition)
      return c.INACTIVE ?? 0x555555
  }
}

/** Effective floor elevation (grid units) for a doc: the Levels module floor bottom
 * (flags.levels.rangeBottom) when present, else the document's own elevation. */
export function levelsElevation(doc) {
  const lv = doc?.flags?.levels
  if (lv && Number.isFinite(Number(lv.rangeBottom))) return Number(lv.rangeBottom)
  return Number(doc?.elevation) || 0
}

/**
 * A Level's base (floor) elevation in grid units, mirroring Foundry v14
 * (client/documents/level.mjs): a finite derived `elevation.base` wins (live docs
 * carry it); else a finite `elevation.bottom`; else a NULL/open bottom = min(top, 0)
 * — the schema's "null bottom = -Infinity" contract — NOT a hard 0. `Number.isFinite`
 * on the RAW value is deliberate: Number(null) === 0 would mask the open-bottom case.
 */
export function levelBase(level) {
  const e = level?.elevation || {}
  if (Number.isFinite(e.base)) return e.base
  if (Number.isFinite(e.bottom)) return e.bottom
  return Number.isFinite(e.top) ? Math.min(e.top, 0) : 0
}

/** A Level's top elevation in grid units; +Infinity for an open (null/absent) top. */
export function levelTop(level) {
  const t = level?.elevation?.top
  return Number.isFinite(t) ? t : Infinity
}

/**
 * The Level whose half-open band [base, top) contains `elev` (grid units), or null.
 * A token exactly at a shared boundary belongs to the UPPER floor (bands are [b,t)).
 * Used so a first-person view's floor follows the CHARACTER'S ELEVATION (vision +
 * movement), not just its authored token.level membership.
 * @param {object[]} levels  Level docs
 * @param {number} elev
 * @param {(l)=>number} base  base resolver (default levelBase)
 * @param {(l)=>number} top   top resolver (default levelTop)
 */
export function levelContainingElevation(levels, elev, base = levelBase, top = levelTop) {
  if (!Number.isFinite(elev)) return null
  let match = null
  for (const l of levels || []) {
    const b = base(l)
    const t = top(l)
    if (elev >= b - 0.01 && elev < t - 0.01) {
      if (!match || base(l) > base(match)) match = l // deepest-containing → prefer the higher floor
    }
  }
  return match
}

/**
 * The Level a first-person viewer at `elev` treats as its floor for slicing. First the band
 * that CONTAINS the elevation; else — when the viewer has flown ABOVE the top floor, or is
 * hovering in a GAP between non-contiguous floors — the HIGHEST floor at or below the viewer,
 * so the top-down cutaway keeps every lower floor visible instead of collapsing to the
 * authored home level (which snapped the slice cut down and hid the upper floors). Symmetric
 * in the other direction: BELOW every floor (burrowing under the bottom floor) snaps to the
 * LOWEST floor, so descending never re-shows an upper floor the viewer is beneath. Returns
 * null only when there are no levels, or `elev` is non-finite — the caller then falls back to
 * the token's authored `level` membership.
 * @param {object[]} levels  Level docs
 * @param {number} elev  grid units
 * @param {(l)=>number} base  base resolver (default levelBase)
 * @param {(l)=>number} top   top resolver (default levelTop)
 */
export function levelForElevation(levels, elev, base = levelBase, top = levelTop) {
  const contained = levelContainingElevation(levels, elev, base, top)
  if (contained) return contained
  if (!Number.isFinite(elev)) return null
  let best = null
  let bestBase = -Infinity
  for (const l of levels || []) {
    const b = base(l)
    if (b <= elev + 0.01 && b > bestBase) {
      best = l // highest floor at or below the viewer; ties keep the FIRST in doc order,
      bestBase = b // matching levelContainingElevation's `base(l) > base(match)` convention
    }
  }
  if (best) return best
  // Below every floor: snap to the LOWEST floor (mirror of the above-top-floor snap) so the
  // cutaway keeps the bottom slice rather than re-showing an upper floor via the caller's
  // authored-home fallback. null only when there are genuinely no levels.
  let lowest = null
  let lowestBase = Infinity
  for (const l of levels || []) {
    const b = base(l)
    if (b < lowestBase) {
      lowest = l
      lowestBase = b
    }
  }
  return lowest
}

/**
 * Pick the "active" (viewed) Level by camera mode. In firstperson (character) view the
 * SUBJECT's floor wins outright — regardless of the off-by-default focus-follow toggle or
 * where the GM navigated (canvas.level) — because the camera is anchored on the character.
 * Every other mode reproduces the legacy precedence exactly: focus-follow → canvas.level →
 * scene._view → topmost. Pure: the host supplies ids + a `get(id)→level` resolver.
 * @param {object} ctx { mode, get, firstPersonLevelId, focusFollow, focusLevelId, canvasLevel, viewLevelId, allLevels, levelBase }
 */
export function resolveActiveLevel(ctx) {
  const get = ctx.get || (() => null)
  if (ctx.mode === 'firstperson') {
    const l = get(ctx.firstPersonLevelId)
    if (l) return l
  }
  if (ctx.focusFollow) {
    const l = get(ctx.focusLevelId)
    if (l) return l
  }
  if (ctx.canvasLevel) return ctx.canvasLevel
  const v = get(ctx.viewLevelId)
  if (v) return v
  const base = ctx.levelBase || levelBase
  let top = null
  for (const l of ctx.allLevels || []) if (!top || base(l) > base(top)) top = l
  return top
}

/**
 * Tiles as viewer-core `tiles[]` entries (textured quads at their floor elevation).
 * @param {object[]} docs  TileDocuments
 * @param {object} ctx  { pxPerUnit, docInSlice(doc)→bool, assetUrl(src)→string }
 */
export function buildTilesJson(docs, ctx) {
  const out = []
  for (const d of docs || []) {
    try {
      if (!d || d.hidden || !ctx.docInSlice(d)) continue
      const w = Number(d.width) || 0
      const h = Number(d.height) || 0
      if (w < 1 || h < 1) continue
      const elev = levelsElevation(d)
      const src = d.texture?.src
      // Ride the heightmap terrain (if any) so a ground tile isn't buried under raised land.
      const ground = ctx.terrainAt ? ctx.terrainAt((Number(d.x) || 0) + w / 2, (Number(d.y) || 0) + h / 2) : null
      const lift = ground != null ? ground * ctx.pxPerUnit + 2 : 0 // +2px avoids z-fighting with the surface
      out.push({
        id: d.id,
        x: Number(d.x) || 0,
        y: Number(d.y) || 0,
        width: w,
        height: h,
        elevation: elev * ctx.pxPerUnit + lift,
        texture: src ? ctx.assetUrl(src) : null,
        alpha: Number.isFinite(Number(d.alpha)) ? Number(d.alpha) : 1,
        color: elev > 0 ? 0x7a6a52 : 0x515b6b, // no texture → tint by elevation
      })
    } catch {
      /* skip a malformed tile */
    }
  }
  return out
}

/**
 * Map note pins as viewer-core `notes[]` entries — flat billboard markers.
 * @param {object[]} notes  Note placeables ({ center, document })
 * @param {(src)=>string} assetUrl
 */
export function buildNotesJson(notes, assetUrl) {
  const out = []
  for (const note of notes || []) {
    try {
      const doc = note.document
      const x = note.center?.x ?? doc.x ?? 0
      const y = note.center?.y ?? doc.y ?? 0
      const src = doc.texture?.src
      out.push({ id: doc.id, x, y, size: doc.iconSize || 50, texture: src ? assetUrl(src) : null })
    } catch {
      /* skip a malformed note */
    }
  }
  return out
}

/**
 * A token document → viewer token JSON (pure shaping; the caller does the Foundry
 * gating — slice + per-player visibility — and passes resolved size/floor).
 * @param {object} doc  TokenDocument
 * @param {object} ctx  { pxPerUnit, sizePx:{w,h}, floorElevation, assetUrl, dispositionColors?,
 *   hasPlayerOwner?, isSecretFromViewer? }
 */
export function buildTokenJson(doc, ctx) {
  const cfgFlags = doc.flags?.['crit-fumble-core'] || {}
  const modelSrc = cfgFlags.modelSrc || cfgFlags.model3d
  // Mirrors TokenDocument#isSecret (client/documents/token.mjs): a SECRET token this viewer
  // can't observe gets none of its informational chrome — substitute the neutral/INACTIVE
  // color instead of leaking "the GM marked this one secret" via the disposition ring.
  const color = ctx.isSecretFromViewer
    ? dispositionColor(undefined, false, ctx.dispositionColors)
    : dispositionColor(doc.disposition, ctx.hasPlayerOwner, ctx.dispositionColors)
  // Dynamic Token Ring: when enabled, Foundry draws the ring's SUBJECT texture (a
  // transparent-background portrait, often system-remapped) instead of the raw token art —
  // the live document has already run prepareDerivedData, so this is correct as-is. Its own
  // colours (ring/background) and subject scale carry through too so the ring looks right.
  const ring = doc.ring?.enabled ? doc.ring : null
  const artSrc = (ring && ring.subject?.texture) || doc.texture?.src
  return {
    id: doc.id,
    x: doc.x || 0,
    y: doc.y || 0,
    width: ctx.sizePx.w,
    height: ctx.sizePx.h,
    elevation: (Number(doc.elevation || 0) + (Number(ctx.groundOffsetUnits) || 0)) * ctx.pxPerUnit,
    floorElevation: ctx.floorElevation,
    color,
    texture: artSrc ? ctx.assetUrl(artSrc) : null,
    model: modelSrc ? ctx.assetUrl(modelSrc) : null,
    modelScale: Number.isFinite(cfgFlags.modelScale) ? cfgFlags.modelScale : undefined,
    modelRotation: Number.isFinite(cfgFlags.modelRotation) ? cfgFlags.modelRotation : undefined,
    // Texture transform + whole-token opacity (the core renders these; alpha is host-computed
    // so it can fold in the GM hidden-token dim). Undefined → the core's default (1 / no tint).
    tint: ctx.tint,
    alpha: ctx.alpha,
    textureScaleX: ctx.textureScaleX,
    textureScaleY: ctx.textureScaleY,
    // Dynamic Token Ring appearance (undefined when the ring is off → core defaults).
    artScale: ring && Number.isFinite(Number(ring.subject?.scale)) ? Number(ring.subject.scale) : undefined,
    ringColor: ring ? parseHexColor(ring.colors?.ring, undefined) : undefined,
    ringBackground: ring ? parseHexColor(ring.colors?.background, undefined) : undefined,
    selected: !!ctx.selected,
    targeted: !!ctx.targeted,
    targetColor: ctx.targetColor,
  }
}

/**
 * Ambient + point lights as a viewer-core `{ ambient, lights }` pair.
 *
 * Ambient mirrors Foundry's own effective brightness: `globalLight` (or low darkness)
 * → fully lit; the floor is drawn emissively at `floorBrightness` so the MAP matches
 * Foundry's 2D, while hemisphere/sun give FORM (token/wall shading + shadows). Intensities
 * are boosted for three r155+ physical lights. Point lights come from AmbientLight
 * placeables + token-emitted light; the first few cast shadows (walls block them), capped.
 *
 * @param {object[]} lightDocs  AmbientLight documents ({ config, x, y, elevation, hidden })
 * @param {object[]} tokenDocs  Token documents (for token.light)
 * @param {object} ctx
 *   - env {daylight,darkCol,brightest,darkness,globalLightOn}  read from Foundry's environment
 *   - size {number}  grid size px · shadows {boolean} · pxPerUnit {number}
 *   - docInSlice {(doc)=>bool} · tokenSizePx {(doc)=>{w,h}}
 */
export function buildLightsJson(lightDocs, tokenDocs, ctx) {
  const { daylight, darkCol, brightest, darkness, globalLightOn } = ctx.env
  const day = Math.max(0, Math.min(1, 1 - darkness))
  const lit = globalLightOn ? 1 : day
  const size = ctx.size
  const shadows = ctx.shadows
  const ambient = {
    hemisphere: { sky: daylight, ground: darkCol, intensity: 0.6 + 0.9 * lit },
    sun: { color: brightest, intensity: 0.4 + 0.9 * lit, castShadow: shadows, shadowNormalBias: size * 0.04 },
    floorBrightness: +(0.55 + 0.4 * lit).toFixed(3),
  }
  const pxPerUnit = ctx.pxPerUnit
  const lights = []
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
  for (const d of lightDocs || []) {
    try {
      if (d?.hidden || !ctx.docInSlice(d)) continue
      addPointLight(d.config, Number(d.x) || 0, Number(d.y) || 0, (Number(d.elevation) || 0) * pxPerUnit)
    } catch {
      /* skip */
    }
  }
  for (const d of tokenDocs || []) {
    try {
      if (!ctx.docInSlice(d)) continue
      const { w, h } = ctx.tokenSizePx(d)
      addPointLight(d?.light, (Number(d.x) || 0) + w / 2, (Number(d.y) || 0) + h / 2, (Number(d.elevation) || 0) * pxPerUnit)
    } catch {
      /* skip */
    }
  }
  return { ambient, lights }
}

/**
 * Native v14 Level maps as viewer-core `levels[]` entries (a textured quad per level
 * background/foreground). Floors are sorted for stable stacking, clipped to the slice
 * cut, filtered by per-player visibility; a level's roof/foreground renders only for
 * floors strictly below the active one (so a ceiling never blocks the view down). Falls
 * back to a single scene-background quad when there are no Level documents.
 *
 * @param {object[]} levels  scene Level documents ({ sort, elevation, background, foreground, textures })
 * @param {object} ctx
 *   - levelElevPx(level, which)  a level edge's elevation in px
 *   - assetUrl(src) · sliceCut() · levelBase(level) · activeLevel() · userCanSeeLevel(level) · backgroundSrc()
 */
export function buildLevelsJson(levels, ctx) {
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
      elevation: ctx.levelElevPx(level, which),
      which,
      src: ctx.assetUrl(src),
      alphaTest: Number.isFinite(at) ? at : 0.75,
      tint: Number.isFinite(tint) && tint !== 0xffffff ? tint : undefined, // Foundry Color is a Number subclass
      rotation: Number.isFinite(rot) && rot !== 0 ? -(rot * Math.PI) / 180 : undefined,
      offsetX: Number(t.offsetX) || 0,
      offsetY: Number(t.offsetY) || 0,
    })
  }
  if (levels?.length) {
    // Sort by `sort` so equal-elevation floors keep a stable stacking order.
    const sorted = [...levels].sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0))
    const cut = ctx.sliceCut()
    const active = ctx.activeLevel() || sorted[sorted.length - 1]
    const activeBase = ctx.levelBase(active)
    // TRUE first-person (enclosed): the character sees only its OWN floor + floors that floor
    // authors as visible-through, and looks UP at its own ceiling. Every other mode keeps the
    // top-down cutaway (all floors at/below the slice, no own ceiling).
    const fp = ctx.firstPerson === true
    const activeCeilinged = fp && Number.isFinite(levelTop(active)) // no ceiling on an open-sky (null-top) floor
    for (const level of sorted) {
      if (!ctx.userCanSeeLevel(level)) continue // players: availableLevels gate, first, both modes
      const isActive = level === active
      if (fp) {
        if (!isActive && !ctx.levelVisibleFromActive(level)) continue // enclosed: only visible-through floors
      } else if (ctx.levelBase(level) > cut + 0.01) {
        continue // cutaway: floor above the slice → hidden
      }
      addQuad(level, level.background, 'bottom')
      // Foreground: floors strictly BELOW active (seen down through openings, both modes) +
      // the active level's OWN ceiling in true first-person (looked up at). Never a ceiling on
      // an open-top floor, whose foreground has no real height to sit at.
      if (ctx.levelBase(level) < activeBase - 0.01 || (activeCeilinged && isActive)) addQuad(level, level.foreground, 'top')
    }
  }
  if (!out.length) {
    const src = ctx.backgroundSrc()
    if (src) out.push({ elevation: 0, which: 'bottom', src: ctx.assetUrl(src), alphaTest: 0 })
  }
  return out
}

/**
 * Native Foundry Regions → viewer terrain (flat-topped extruded tiers). Each input is a
 * region ALREADY resolved by the host to Foundry's own geometry:
 *   { id, surface, base, vertices, indices, rings, color?, opacity? }
 * where `surface`/`base` are grid-unit heights, `vertices`/`indices` the footprint
 * triangulation and `rings` the boundary loops (both canvas px). Scales heights to px and
 * drops any region without a finite surface or usable geometry. Pure + unit-testable.
 * @param {object[]} regions
 * @param {object} ctx { pxPerUnit }
 */
export function buildRegionsJson(regions, ctx) {
  const out = []
  const px = ctx.pxPerUnit
  for (const r of regions || []) {
    if (!r || !Number.isFinite(r.surface)) continue
    if (!r.vertices?.length || !r.indices?.length) continue
    out.push({
      id: r.id,
      elevation: r.surface * px,
      base: (Number.isFinite(r.base) ? r.base : 0) * px,
      vertices: r.vertices,
      indices: r.indices,
      rings: r.rings || [],
      src: r.src,
      color: r.color,
      opacity: r.opacity,
    })
  }
  return out
}

/**
 * Heightmap flag → viewer terrain. `field` is the raw scene flag
 * { cols, rows, heights:number[] } with heights in grid UNITS (row-major, cols×rows). Scales
 * heights to px. Returns null when absent/degenerate so the core keeps its flat map floor.
 * @param {object} field
 * @param {object} ctx { pxPerUnit, src?, color? }
 */
export function buildTerrainJson(field, ctx) {
  if (!field) return null
  const cols = Math.floor(Number(field.cols))
  const rows = Math.floor(Number(field.rows))
  if (!(cols >= 2) || !(rows >= 2)) return null
  const data = field.heights
  if (!Array.isArray(data) || data.length < cols * rows) return null
  const px = ctx.pxPerUnit
  const heights = data.map((h) => (Number.isFinite(Number(h)) ? Number(h) * px : 0))
  return { cols, rows, heights, src: ctx.src, color: ctx.color }
}

/** Parse a Foundry colour (hex string "#rrggbb" or a number) to a 0xRRGGBB number. */
export function parseHexColor(c, dflt) {
  if (c == null || c === '') return dflt
  if (typeof c === 'number') return c
  const n = parseInt(String(c).replace('#', ''), 16)
  return Number.isFinite(n) ? n : dflt
}

/**
 * Grid-helper config. Mirrors Foundry's own grid: its configured line colour (a hex
 * STRING like "#999999" — the old `Number()` made it NaN) defaulting to light grey,
 * and its alpha with a visible floor so it doesn't wash out in 3D. Gridless (type 0) → off.
 * @param {object} grid  the scene's grid ({ type, color, alpha })
 * @param {number} size  grid size in px
 */
export function buildGridJson(grid, size) {
  return {
    size: size || 100,
    showHelper: !(grid && grid.type === 0),
    color: parseHexColor(grid?.color, 0xcccccc),
    opacity: grid?.alpha != null ? Math.max(0.25, Number(grid.alpha)) : 0.4,
  }
}

/**
 * Extruded wall segments as viewer-core `walls[]` entries.
 *
 * @param {object[]} docs  Foundry WallDocuments (each: c, door, ds, dir, light, sight, move, flags).
 * @param {object} ctx
 *   - pxPerUnit {number}          world px per grid distance unit
 *   - ceilUnits {number|null}     slice ceiling in grid units (clip tall walls), or null for no cut
 *   - docInSlice {(doc)=>boolean} whether the wall is on a visible floor
 *   - wallBand {(doc)=>{bottom,top}} the wall's vertical band in grid units
 *   - assetUrl {(src)=>string}    resolve a texture path to an absolute URL
 * @returns viewer `walls[]`
 */
export function buildWallsJson(docs, ctx) {
  const out = []
  for (const doc of docs || []) {
    try {
      if (!doc || !ctx.docInSlice(doc)) continue // wall on a floor above the slice → hidden
      const c = doc.c
      if (!Array.isArray(c) || c.length < 4) continue
      const [x1, y1, x2, y2] = c
      const band = ctx.wallBand(doc)
      let wbottom = band.bottom
      let wtop = band.top
      // Cutaway: clip a tall, multi-floor wall to the active floor's ceiling so only its
      // current-floor section shows and it can't block the view down.
      if (ctx.ceilUnits != null && Number.isFinite(ctx.ceilUnits)) wtop = Math.min(wtop, ctx.ceilUnits)
      if (wtop - wbottom < 0.01) continue // nothing left after the cut
      const len = Math.hypot(x2 - x1, y2 - y1)
      if (len < 1) continue
      // door 0/1/2 = none/door/SECRET, ds 0/1/2 = closed/open/locked. A SECRET door is
      // drawn as an ordinary WALL — indistinguishable — for EVERYONE (players so they
      // can't spot hidden passages, and the GM by request; secret doors are managed in
      // the 2D view). It reads as a door only once OPENED (revealed); once the GM
      // un-secrets it (door === 1) it's a normal door. Nothing about a closed secret
      // door reaches the renderer. Window: blocks movement, not sight (none/proximity).
      const ds = doc.ds === 1 ? 'open' : doc.ds === 2 ? 'locked' : 'closed'
      let kind = 'wall'
      let doorState
      if (doc.door === 1) {
        kind = 'door'
        doorState = ds
      } else if (doc.door === 2 && ds === 'open') {
        kind = 'door' // an opened secret door is revealed as an ordinary open door
        doorState = 'open'
      } else if (doc.door !== 2 && (doc.move ?? 0) > 0 && (doc.sight === 0 || doc.sight === 30)) {
        kind = 'window'
      }
      const wall = { id: doc.id, x1, y1, x2, y2, bottom: wbottom * ctx.pxPerUnit, top: wtop * ctx.pxPerUnit, kind }
      if (kind === 'wall') wall.opacity = 0.85 // door/window style opacity is the core's business
      if (doorState) wall.doorState = doorState
      // Native restriction nodes for the renderer: `dir` = one-sided (0 both/1 left/2
      // right); only light-blocking walls should cast shadows. (Sound/threshold aren't visual.)
      wall.dir = doc.dir ?? 0
      wall.blocksLight = (doc.light ?? 20) !== 0
      wall.blocksSight = (doc.sight ?? 20) !== 0
      // Base 3D texture: OUR OWN texture flag drives the render for ANY segment,
      // independent of Foundry's door-animation (whose texture is tied to the animation
      // type and, for non-doors, is purged on save). Native `animation.texture` is a
      // FALLBACK. NO texture → an optional flat wall COLOUR (else the core's default).
      // Cascade: the wall's OWN flag wins, then Foundry's native door texture, then the
      // scene/level 3D default (resolved by the host — level over scene). Lets a GM set a
      // texture/colour once per level or scene instead of on every segment.
      const a = doc.animation || {}
      const cfg = doc.flags?.['crit-fumble-core'] || {}
      const dflt = ctx.wall3dDefaults ? ctx.wall3dDefaults(doc) || {} : {}
      const texSrc = cfg.texture || a.texture || dflt.texture
      if (texSrc) {
        wall.texture = ctx.assetUrl(texSrc)
        if (cfg.flip ?? a.flip) wall.flip = true
        // Tile the texture — DEFAULT one tile per grid cell (square); `tileScale` = tiles
        // per cell. tileX/Y are UV repeat counts over the segment's length/height.
        // `||` (not `??`): a blank field submits as '' — it should INHERIT the default,
        // not shadow it. 0/'' are invalid scales anyway, so falling through is correct.
        const rawScale = cfg.tileScale || dflt.tileScale
        const scale = Number(rawScale) > 0 ? Number(rawScale) : 1
        const grid = ctx.gridSize || 100
        wall.tileX = +((len / grid) * scale).toFixed(3)
        wall.tileY = +(((wall.top - wall.bottom) / grid) * scale).toFixed(3)
      } else {
        const col = parseHexColor(cfg.color || dflt.color, null)
        if (col != null) wall.color = col // a plain coloured wall (else the core's default palette)
      }
      if (kind === 'door') {
        if (a.double) wall.double = true
        if (a.direction != null) wall.swingDir = a.direction // -1 | 1
        if (a.type) wall.animType = a.type // 'swing' | 'slide' | …
      }
      out.push(wall)
    } catch {
      /* skip a malformed wall */
    }
  }
  return out
}
