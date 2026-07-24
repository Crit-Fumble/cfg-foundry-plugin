// node_modules/@crit-fumble/shared/dist/vtt-viewer/terrain-brush.js
function forEachInRadius(cols, rows, ci, cj, radiusCells, shape, fn) {
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
      fn(i, j, 1 - dist / r);
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
  const ci = u * (cols - 1);
  const cj = v * (rows - 1);
  const radiusCells = Math.max(0.5, (Number(opts?.radius) || 0.08) * Math.max(cols, rows));
  const strength = Number.isFinite(Number(opts?.strength)) ? Number(opts.strength) : 1;
  const level = Number(opts?.level) || 0;
  const shape = opts?.shape === "square" ? "square" : "circle";
  forEachInRadius(cols, rows, ci, cj, radiusCells, shape, (i, j, falloff) => {
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
