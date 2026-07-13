// node_modules/@crit-fumble/shared/dist/vtt-viewer/producer.js
function parseHexColor(c, dflt) {
  if (c == null || c === "")
    return dflt;
  if (typeof c === "number")
    return c;
  const n = parseInt(String(c).replace("#", ""), 16);
  return Number.isFinite(n) ? n : dflt;
}
function dispositionColor(disposition, hasPlayerOwner = false, colors) {
  const c = colors || {};
  switch (disposition) {
    case 1:
      return (hasPlayerOwner ? c.PARTY : c.FRIENDLY) ?? (hasPlayerOwner ? 3390542 : 4448223);
    case -1:
      return c.HOSTILE ?? 15147300;
    case -2:
      return c.SECRET ?? 10883796;
    case 0:
      return c.NEUTRAL ?? 15849526;
    default:
      return c.INACTIVE ?? 5592405;
  }
}
function cfgFlags(flags) {
  const legacy = flags?.["crit-fumble-core"] || {};
  const next = flags?.["playtable"] || {};
  return { ...legacy, ...next };
}
var num = (v, dflt = 0) => Number.isFinite(Number(v)) ? Number(v) : dflt;
function levelBase(level) {
  const e = level?.elevation || {};
  if (Number.isFinite(e.base))
    return e.base;
  if (Number.isFinite(e.bottom))
    return e.bottom;
  return Number.isFinite(e.top) ? Math.min(e.top, 0) : 0;
}
function levelTop(level) {
  const t = level?.elevation?.top;
  return Number.isFinite(t) ? t : Infinity;
}
function levelContainingElevation(levels, elev, base = levelBase, top = levelTop) {
  if (!Number.isFinite(elev))
    return null;
  let match = null;
  for (const l of levels || []) {
    const b = base(l);
    const t = top(l);
    if (elev >= b - 0.01 && elev < t - 0.01) {
      if (!match || base(l) > base(match))
        match = l;
    }
  }
  return match;
}
function levelForElevation(levels, elev, base = levelBase, top = levelTop) {
  const contained = levelContainingElevation(levels, elev, base, top);
  if (contained)
    return contained;
  if (!Number.isFinite(elev))
    return null;
  let best = null;
  let bestBase = -Infinity;
  for (const l of levels || []) {
    const b = base(l);
    if (b <= elev + 0.01 && b > bestBase) {
      best = l;
      bestBase = b;
    }
  }
  if (best)
    return best;
  let lowest = null;
  let lowestBase = Infinity;
  for (const l of levels || []) {
    const b = base(l);
    if (b < lowestBase) {
      lowest = l;
      lowestBase = b;
    }
  }
  return lowest;
}
function resolveActiveLevel(ctx) {
  const get = ctx.get || (() => null);
  if (ctx.mode === "firstperson") {
    const l = get(ctx.firstPersonLevelId);
    if (l)
      return l;
  }
  if (ctx.focusFollow) {
    const l = get(ctx.focusLevelId);
    if (l)
      return l;
  }
  if (ctx.canvasLevel)
    return ctx.canvasLevel;
  const v = get(ctx.viewLevelId);
  if (v)
    return v;
  const base = ctx.levelBase || levelBase;
  let top = null;
  for (const l of ctx.allLevels || [])
    if (!top || base(l) > base(top))
      top = l;
  return top;
}
function buildGridJson(grid, size) {
  return {
    size: size || 100,
    showHelper: !(grid && grid.type === 0),
    color: parseHexColor(grid?.color, 13421772),
    // Finite guard: a non-numeric alpha must fall back, not emit NaN opacity.
    opacity: Number.isFinite(Number(grid?.alpha)) ? Math.max(0.25, Number(grid?.alpha)) : 0.4
  };
}
function levelsElevation(doc) {
  const rb = doc?.flags?.levels?.rangeBottom;
  if (Number.isFinite(Number(rb)))
    return Number(rb);
  return num(doc?.elevation);
}
function buildTilesJson(docs, ctx) {
  const out = [];
  for (const d of docs || []) {
    try {
      if (!d || d.hidden || !ctx.docInSlice(d))
        continue;
      const w = num(d.width);
      const h = num(d.height);
      if (w < 1 || h < 1)
        continue;
      const elev = levelsElevation(d);
      const src = d.texture?.src;
      const ground = ctx.terrainAt ? ctx.terrainAt(num(d.x) + w / 2, num(d.y) + h / 2) : null;
      const lift = ground != null ? ground * ctx.pxPerUnit + 2 : 0;
      out.push({
        id: d.id ?? d._id,
        x: num(d.x),
        y: num(d.y),
        width: w,
        height: h,
        elevation: elev * ctx.pxPerUnit + lift,
        texture: src ? ctx.assetUrl(src) : null,
        alpha: Number.isFinite(Number(d.alpha)) ? Number(d.alpha) : 1,
        color: elev > 0 ? 8022610 : 5331819
        // no texture → tint by elevation
      });
    } catch {
    }
  }
  return out;
}
function buildNotesJson(notes, assetUrl) {
  const out = [];
  for (const note of notes || []) {
    try {
      const doc = note.document ?? note;
      const x = note.center?.x ?? doc.x ?? 0;
      const y = note.center?.y ?? doc.y ?? 0;
      const src = doc.texture?.src;
      out.push({ id: doc.id ?? doc._id, x, y, size: doc.iconSize || 50, texture: src ? assetUrl(src) : null });
    } catch {
    }
  }
  return out;
}
function buildRegionsJson(regions, ctx) {
  const out = [];
  const px = ctx.pxPerUnit;
  for (const r of regions || []) {
    if (!r || !Number.isFinite(r.surface))
      continue;
    if (!r.vertices?.length || !r.indices?.length)
      continue;
    out.push({
      id: r.id,
      elevation: r.surface * px,
      base: (Number.isFinite(r.base) ? r.base : 0) * px,
      vertices: r.vertices,
      indices: r.indices,
      rings: r.rings || [],
      src: r.src,
      color: r.color,
      opacity: r.opacity
    });
  }
  return out;
}
function buildTerrainJson(field, ctx) {
  if (!field)
    return null;
  const cols = Math.floor(num(field.cols));
  const rows = Math.floor(num(field.rows));
  if (!(cols >= 2) || !(rows >= 2))
    return null;
  const data = field.heights;
  if (!Array.isArray(data) || data.length < cols * rows)
    return null;
  const px = ctx.pxPerUnit;
  const heights = data.map((h) => Number.isFinite(Number(h)) ? Number(h) * px : 0);
  return { cols, rows, heights, src: ctx.src, color: ctx.color };
}
function buildLevelsJson(levels, ctx) {
  const out = [];
  const addQuad = (level, texData, which) => {
    const src = texData?.src;
    if (!src)
      return;
    if (/\.(webm|mp4|m4v|ogv)$/i.test(src))
      return;
    const t = level?.textures || {};
    const at = Number(texData.alphaThreshold);
    const tint = Number(texData.tint);
    const rot = Number(t.rotation);
    const resolved = ctx.assetUrl(src);
    if (!resolved)
      return;
    out.push({
      elevation: ctx.levelElevPx(level, which),
      which,
      src: resolved,
      alphaTest: Number.isFinite(at) ? at : 0.75,
      tint: Number.isFinite(tint) && tint !== 16777215 ? tint : void 0,
      rotation: Number.isFinite(rot) && rot !== 0 ? -(rot * Math.PI) / 180 : void 0,
      offsetX: num(t.offsetX),
      offsetY: num(t.offsetY)
    });
  };
  if (levels?.length) {
    const sorted = [...levels].sort((a, b) => num(a.sort) - num(b.sort));
    const cut = ctx.sliceCut();
    const active = ctx.activeLevel() || sorted[sorted.length - 1];
    const activeBase = ctx.levelBase(active);
    const fp = ctx.firstPerson === true;
    const activeCeilinged = fp && Number.isFinite(levelTop(active));
    for (const level of sorted) {
      if (!ctx.userCanSeeLevel(level))
        continue;
      const isActive = level === active;
      if (ctx.renderAll) {
      } else if (fp) {
        if (!isActive && !(ctx.levelVisibleFromActive?.(level) ?? false))
          continue;
      } else if (ctx.levelBase(level) > cut + 0.01) {
        continue;
      }
      addQuad(level, level.background, "bottom");
      if (ctx.renderAll || ctx.levelBase(level) < activeBase - 0.01 || activeCeilinged && isActive)
        addQuad(level, level.foreground, "top");
    }
  }
  if (!out.length) {
    const src = ctx.backgroundSrc();
    const resolved = src ? ctx.assetUrl(src) : null;
    if (resolved)
      out.push({ elevation: 0, which: "bottom", src: resolved, alphaTest: 0 });
  }
  return out;
}
function buildLightsJson(lightDocs, tokenDocs, ctx) {
  const { daylight, darkCol, brightest, darkness, globalLightOn } = ctx.env;
  const day = Math.max(0, Math.min(1, 1 - darkness));
  const lit = globalLightOn ? 1 : day;
  const size = ctx.size;
  const shadows = ctx.shadows;
  const co = ctx.ambientCoeffs || {};
  const hemiBase = co.hemiBase ?? 0.6;
  const hemiLit = co.hemiLit ?? 0.9;
  const sunBase = co.sunBase ?? 0.4;
  const sunLit = co.sunLit ?? 0.9;
  const ambient = {
    hemisphere: { sky: daylight, ground: darkCol, intensity: hemiBase + hemiLit * lit },
    sun: { color: brightest, intensity: sunBase + sunLit * lit, castShadow: shadows, shadowNormalBias: size * 0.04 },
    floorBrightness: +(0.55 + 0.4 * lit).toFixed(3)
  };
  const pxPerUnit = ctx.pxPerUnit;
  const lights = [];
  let shadowBudget = shadows ? 4 : 0;
  const addPointLight = (cfg, x, y, elevPx) => {
    if (!cfg)
      return;
    const dim = num(cfg.dim);
    const bright = num(cfg.bright);
    if (dim <= 0 && bright <= 0)
      return;
    const color = cfg.color != null ? parseHexColor(cfg.color, 16777215) : 16777215;
    const radius = Math.max(dim, bright) * pxPerUnit || size * 4;
    const castShadow = shadowBudget > 0;
    if (castShadow)
      shadowBudget--;
    lights.push({
      x,
      y,
      elevation: elevPx + size * 0.6,
      color,
      radius,
      intensity: 1.3 + num(cfg.luminosity),
      castShadow,
      shadowNear: size * 0.2,
      shadowNormalBias: size * 0.05
    });
  };
  for (const d of lightDocs || []) {
    try {
      if (d?.hidden || !ctx.docInSlice(d))
        continue;
      addPointLight(d.config, num(d.x), num(d.y), num(d.elevation) * pxPerUnit);
    } catch {
    }
  }
  for (const d of tokenDocs || []) {
    try {
      if (!ctx.docInSlice(d))
        continue;
      const { w, h } = ctx.tokenSizePx(d);
      addPointLight(d?.light, num(d.x) + w / 2, num(d.y) + h / 2, num(d.elevation) * pxPerUnit);
    } catch {
    }
  }
  return { ambient, lights };
}
function capLights(lights, opts) {
  const maxLights = Math.max(0, opts.maxLights ?? 24);
  const shadowBudget = Math.max(0, opts.shadowBudget ?? 4);
  const kept = [...lights].sort((a, b) => (b.radius ?? 0) * (b.intensity ?? 1) - (a.radius ?? 0) * (a.intensity ?? 1)).slice(0, maxLights);
  kept.forEach((l, i) => {
    l.castShadow = i < shadowBudget;
  });
  return kept;
}
function buildTokenJson(doc, ctx) {
  const flags = cfgFlags(doc.flags);
  const modelSrc = flags.modelSrc || flags.model3d;
  const color = ctx.isSecretFromViewer ? dispositionColor(void 0, false, ctx.dispositionColors) : dispositionColor(doc.disposition, ctx.hasPlayerOwner, ctx.dispositionColors);
  const ring = doc.ring?.enabled ? doc.ring : null;
  const artSrc = ring && ring.subject?.texture || doc.texture?.src;
  return {
    id: doc.id ?? doc._id,
    x: num(doc.x),
    y: num(doc.y),
    width: ctx.sizePx.w,
    height: ctx.sizePx.h,
    elevation: (num(doc.elevation) + num(ctx.groundOffsetUnits)) * ctx.pxPerUnit,
    floorElevation: ctx.floorElevation,
    color,
    texture: artSrc ? ctx.assetUrl(artSrc) : null,
    model: modelSrc ? ctx.assetUrl(modelSrc) : null,
    modelScale: Number.isFinite(Number(flags.modelScale)) ? Number(flags.modelScale) : void 0,
    modelRotation: Number.isFinite(Number(flags.modelRotation)) ? Number(flags.modelRotation) : void 0,
    tint: ctx.tint,
    alpha: ctx.alpha,
    textureScaleX: ctx.textureScaleX,
    textureScaleY: ctx.textureScaleY,
    artScale: ring && Number.isFinite(Number(ring.subject?.scale)) ? Number(ring.subject?.scale) : void 0,
    ringColor: ring ? parseHexColor(ring.colors?.ring, void 0) : void 0,
    ringBackground: ring ? parseHexColor(ring.colors?.background, void 0) : void 0,
    rotation: doc.lockRotation ? 0 : Number.isFinite(Number(doc.rotation)) ? Number(doc.rotation) : void 0,
    fit: doc.texture?.fit || "contain",
    selected: !!ctx.selected,
    targeted: !!ctx.targeted,
    targetColor: ctx.targetColor
  };
}
function buildWallsJson(docs, ctx) {
  const out = [];
  for (const doc of docs || []) {
    try {
      if (!doc || !ctx.docInSlice(doc))
        continue;
      const c = doc.c;
      if (!Array.isArray(c) || c.length < 4)
        continue;
      const [x1, y1, x2, y2] = c;
      const band = ctx.wallBand(doc);
      let wbottom = band.bottom;
      let wtop = band.top;
      if (ctx.ceilUnits != null && Number.isFinite(ctx.ceilUnits))
        wtop = Math.min(wtop, ctx.ceilUnits);
      if (wtop - wbottom < 0.01)
        continue;
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len < 1)
        continue;
      const ds = doc.ds === 1 ? "open" : doc.ds === 2 ? "locked" : "closed";
      let kind = "wall";
      let doorState;
      if (doc.door === 1) {
        kind = "door";
        doorState = ds;
      } else if (doc.door === 2 && ctx.revealSecretDoors && ctx.viewerIsGm) {
        kind = "secretDoor";
        doorState = ds;
      } else if (doc.door === 2 && ds === "open") {
        kind = "door";
        doorState = "open";
      } else if (doc.door !== 2 && (doc.move ?? 0) > 0 && (doc.sight === 0 || doc.sight === 30)) {
        kind = "window";
      }
      const bottomPx = wbottom * ctx.pxPerUnit;
      const topPx = wtop * ctx.pxPerUnit;
      const wall = { id: doc.id ?? doc._id, x1, y1, x2, y2, bottom: bottomPx, top: topPx, kind };
      if (kind === "wall")
        wall.opacity = ctx.wallOpacity ?? 0.85;
      if (doorState)
        wall.doorState = doorState;
      wall.blocksSight = doorState !== "open" && (doc.sight ?? 20) !== 0;
      wall.dir = doc.dir ?? 0;
      wall.blocksLight = (doc.light ?? 20) !== 0;
      const a = doc.animation || {};
      const cfg = cfgFlags(doc.flags);
      const dflt = ctx.wall3dDefaults ? ctx.wall3dDefaults(doc) || {} : {};
      const texSrc = cfg.texture || a.texture || dflt.texture;
      if (texSrc) {
        const resolved = ctx.assetUrl(texSrc);
        if (resolved)
          wall.texture = resolved;
        if (cfg.flip ?? a.flip)
          wall.flip = true;
        const rawScale = cfg.tileScale || dflt.tileScale;
        const scale = Number(rawScale) > 0 ? Number(rawScale) : 1;
        const grid = ctx.gridSize || 100;
        wall.tileX = +(len / grid * scale).toFixed(3);
        wall.tileY = +((topPx - bottomPx) / grid * scale).toFixed(3);
      } else {
        const col = parseHexColor(cfg.color || dflt.color, void 0);
        if (col != null)
          wall.color = col;
      }
      if (kind === "door") {
        if (a.double)
          wall.double = true;
        if (a.direction != null)
          wall.swingDir = a.direction;
        if (a.type)
          wall.animType = a.type;
      }
      out.push(wall);
    } catch {
    }
  }
  return out;
}
export {
  buildGridJson,
  buildLevelsJson,
  buildLightsJson,
  buildNotesJson,
  buildRegionsJson,
  buildTerrainJson,
  buildTilesJson,
  buildTokenJson,
  buildWallsJson,
  capLights,
  cfgFlags,
  dispositionColor,
  levelBase,
  levelContainingElevation,
  levelForElevation,
  levelTop,
  levelsElevation,
  parseHexColor,
  resolveActiveLevel
};
