// node_modules/@crit-fumble/threejs/dist/terrain-brush.js
var FLAT_INNER = 0.7;
function profileFalloff(t, profile) {
  if (profile === "plateau")
    return 1;
  if (profile === "flat")
    return t <= FLAT_INNER ? 1 : Math.max(0, (1 - t) / (1 - FLAT_INNER));
  return 1 - t;
}
function forEachInRadius(cols, rows, ci, cj, radiusCells, shape, profile, fn) {
  const r = Math.max(0.5, radiusCells);
  const iMin = Math.max(0, Math.floor(ci - r));
  const iMax = Math.min(cols - 1, Math.ceil(ci + r));
  const jMin = Math.max(0, Math.floor(cj - r));
  const jMax = Math.min(rows - 1, Math.ceil(cj + r));
  const square = shape === "square";
  for (let j = jMin; j <= jMax; j++) {
    for (let i = iMin; i <= iMax; i++) {
      const dist = square ? Math.max(Math.abs(i - ci), Math.abs(j - cj)) : Math.hypot(i - ci, j - cj);
      if (dist > r)
        continue;
      fn(i, j, profileFalloff(dist / r, profile));
    }
  }
}
function applyTerrainBrush(heights, cols, rows, opts) {
  const out = heights.slice();
  if (!(cols >= 2) || !(rows >= 2) || heights.length < cols * rows)
    return out;
  const mode = opts?.mode || "raise";
  const u = Math.min(1, Math.max(0, Number(opts?.u)));
  const v = Math.min(1, Math.max(0, Number(opts?.v)));
  if (!Number.isFinite(u) || !Number.isFinite(v))
    return out;
  let ci = u * (cols - 1);
  let cj = v * (rows - 1);
  const radiusCells = Math.max(0.5, (Number(opts?.radius) || 0.08) * Math.max(cols, rows));
  if (radiusCells <= 0.75) {
    ci = Math.round(ci);
    cj = Math.round(cj);
  }
  const strength = Number.isFinite(Number(opts?.strength)) ? Number(opts.strength) : 1;
  const level = Number(opts?.level) || 0;
  const shape = opts?.shape === "square" ? "square" : "circle";
  const profile = opts?.profile === "flat" ? "flat" : opts?.profile === "plateau" ? "plateau" : "peak";
  forEachInRadius(cols, rows, ci, cj, radiusCells, shape, profile, (i, j, falloff) => {
    const k = j * cols + i;
    const w = falloff * strength;
    if (mode === "raise")
      out[k] = heights[k] + w;
    else if (mode === "lower")
      out[k] = heights[k] - w;
    else if (mode === "level")
      out[k] = heights[k] + (level - heights[k]) * Math.min(1, Math.max(0, w));
    else if (mode === "smooth") {
      let s = 0;
      let n = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          const jj = j + dj;
          if (ii >= 0 && ii < cols && jj >= 0 && jj < rows) {
            s += heights[jj * cols + ii];
            n++;
          }
        }
      }
      out[k] = heights[k] + (s / n - heights[k]) * Math.min(1, Math.max(0, w));
    }
  });
  return out;
}
export {
  applyTerrainBrush
};
