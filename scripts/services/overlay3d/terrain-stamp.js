// node_modules/@crit-fumble/threejs/dist/terrain-stamp.js
function latticeAlignment(cols, rows, squaresW, squaresH) {
  const sppX = Math.max(1, Math.round((cols - 1) / Math.max(1, squaresW)));
  const sppY = Math.max(1, Math.round((rows - 1) / Math.max(1, squaresH)));
  const aligned = cols - 1 === sppX * squaresW && rows - 1 === sppY * squaresH;
  return { sppX, sppY, aligned };
}
function resampleHeightfield(src, cols, rows) {
  const sc = Math.max(2, Math.floor(src.cols));
  const sr = Math.max(2, Math.floor(src.rows));
  const out = new Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    const v = rows > 1 ? j / (rows - 1) * (sr - 1) : 0;
    const j0 = Math.min(sr - 2, Math.floor(v));
    const fv = v - j0;
    for (let i = 0; i < cols; i++) {
      const u = cols > 1 ? i / (cols - 1) * (sc - 1) : 0;
      const i0 = Math.min(sc - 2, Math.floor(u));
      const fu = u - i0;
      const h00 = Number(src.heights[j0 * sc + i0]) || 0;
      const h10 = Number(src.heights[j0 * sc + i0 + 1]) || 0;
      const h01 = Number(src.heights[(j0 + 1) * sc + i0]) || 0;
      const h11 = Number(src.heights[(j0 + 1) * sc + i0 + 1]) || 0;
      out[j * cols + i] = h00 * (1 - fu) * (1 - fv) + h10 * fu * (1 - fv) + h01 * (1 - fu) * fv + h11 * fu * fv;
    }
  }
  return out;
}
var TerrainStampController = class {
  host;
  cfg;
  cb;
  squaresW;
  squaresH;
  sppX;
  sppY;
  span;
  i;
  // grid-SQUARE index (not sample)
  j;
  level;
  // GAME UNITS
  heights;
  // GAME UNITS
  placed = false;
  commitTimer = null;
  constructor(host, cfg, cb) {
    this.host = host;
    this.cfg = cfg;
    this.cb = cb;
    const { cols, rows, gridSize, boundsWidth, boundsHeight, pxPerUnit } = cfg;
    this.squaresW = Math.max(1, Math.round(boundsWidth / gridSize));
    this.squaresH = Math.max(1, Math.round(boundsHeight / gridSize));
    this.sppX = Math.max(1, Math.round((cols - 1) / this.squaresW));
    this.sppY = Math.max(1, Math.round((rows - 1) / this.squaresH));
    this.span = Math.max(boundsWidth, boundsHeight);
    const livePx = host.getTerrainHeights();
    const basePx = livePx && livePx.length === cols * rows ? livePx : new Array(cols * rows).fill(0);
    this.heights = basePx.map((h) => h / pxPerUnit);
    this.i = Math.floor(this.squaresW / 2);
    this.j = Math.floor(this.squaresH / 2);
    this.level = 0;
    this.placed = false;
  }
  /** Sample index at a grid square's centre (for the level lookup + reticle placement). */
  squareCenterSample(gx, gy) {
    return {
      i: Math.min(this.cfg.cols - 1, gx * this.sppX + Math.floor(this.sppX / 2)),
      j: Math.min(this.cfg.rows - 1, gy * this.sppY + Math.floor(this.sppY / 2))
    };
  }
  /** Brush size in whole grid squares (≥1), from the wheel radius. */
  sizeSquares() {
    return Math.max(1, Math.round(this.cfg.radiusFrac * this.squaresW * 2));
  }
  get currentLevel() {
    return this.level;
  }
  get isPlaced() {
    return this.placed;
  }
  setShape(shape) {
    this.cfg.shape = shape;
    this.refresh();
  }
  setRadiusFrac(radiusFrac) {
    this.cfg.radiusFrac = radiusFrac;
    if (this.placed)
      this.paint();
    else
      this.refresh();
  }
  /** Redraw the reticle over the covered square span at the target level. No terrain change. */
  refresh() {
    const { cols, rows, gridSize, pxPerUnit, shape } = this.cfg;
    const half = Math.floor(this.sizeSquares() / 2);
    const a = this.host.terrainCellToWorld(Math.max(0, (this.i - half) * this.sppX), Math.max(0, (this.j - half) * this.sppY));
    const b = this.host.terrainCellToWorld(Math.min(cols - 1, (this.i + half + 1) * this.sppX), Math.min(rows - 1, (this.j + half + 1) * this.sppY));
    const rFrac = this.sizeSquares() * gridSize / 2 / this.span;
    if (a && b)
      this.host.showReticle((a.x + b.x) / 2, (a.z + b.z) / 2, rFrac, shape, this.level * pxPerUnit, this.placed);
    this.cb.onLevelChange?.(this.level);
    this.cb.onPlacedChange?.(this.placed);
  }
  /** Snap the ghost to the grid square under (u,v) in [0,1] scene space + redraw. No terrain change. */
  moveTo(u, v) {
    this.i = Math.max(0, Math.min(this.squaresW - 1, Math.floor(u * this.squaresW)));
    this.j = Math.max(0, Math.min(this.squaresH - 1, Math.floor(v * this.squaresH)));
    this.refresh();
  }
  /** Drop the stamp at (u,v): imprint + mark resting (the only thing that changes terrain via pointer). */
  placeAt(u, v) {
    this.i = Math.max(0, Math.min(this.squaresW - 1, Math.floor(u * this.squaresW)));
    this.j = Math.max(0, Math.min(this.squaresH - 1, Math.floor(v * this.squaresH)));
    this.placed = true;
    this.paint();
  }
  /** Keyboard: WASD walks the ghost a grid square (seat-relative — TOKEN-movement parity, owner
   *  2026-07-28); Q/E lower/raise the target, BELOW grade allowed (trenches/ditches/pits). Arrow
   *  keys are deliberately NOT handled — they stay bound to the camera, exactly as in 2D view, so
   *  a host's key router must let declined keys fall through to its camera controls. */
  key(rawKey) {
    const k = rawKey.toLowerCase();
    let di = 0;
    let dj = 0;
    let dLevel = 0;
    if (k === "w" || k === "s" || k === "a" || k === "d") {
      const f = this.host.getCameraForward();
      let wx = 0;
      let wz = 0;
      if (k === "w") {
        wx = f.x;
        wz = f.z;
      } else if (k === "s") {
        wx = -f.x;
        wz = -f.z;
      } else if (k === "d") {
        wx = -f.z;
        wz = f.x;
      } else {
        wx = f.z;
        wz = -f.x;
      }
      if (Math.abs(wx) >= Math.abs(wz))
        di = Math.sign(wx);
      else
        dj = Math.sign(wz);
    } else if (k === "e")
      dLevel = this.cfg.step;
    else if (k === "q")
      dLevel = -this.cfg.step;
    else
      return false;
    if (di || dj) {
      this.i = Math.max(0, Math.min(this.squaresW - 1, this.i + di));
      this.j = Math.max(0, Math.min(this.squaresH - 1, this.j + dj));
    } else if (dLevel) {
      this.level = this.level + dLevel;
    }
    if (this.placed)
      this.paint();
    else
      this.refresh();
    return true;
  }
  /** Imprint every covered grid square flat to the target level, re-displace the mesh, debounce a commit. */
  paint() {
    const { cols, rows } = this.cfg;
    const half = Math.floor(this.sizeSquares() / 2);
    for (let gy = this.j - half; gy <= this.j + half; gy++) {
      for (let gx = this.i - half; gx <= this.i + half; gx++) {
        if (gx < 0 || gy < 0 || gx >= this.squaresW || gy >= this.squaresH)
          continue;
        const i0 = gx * this.sppX;
        const j0 = gy * this.sppY;
        for (let jj = j0; jj <= Math.min(rows - 1, j0 + this.sppY); jj++) {
          for (let ii = i0; ii <= Math.min(cols - 1, i0 + this.sppX); ii++)
            this.heights[jj * cols + ii] = this.level;
        }
      }
    }
    this.host.updateTerrainHeights(this.heights.map((h) => h * this.cfg.pxPerUnit));
    this.refresh();
    if (this.commitTimer)
      clearTimeout(this.commitTimer);
    this.commitTimer = setTimeout(() => {
      this.commitTimer = null;
      this.cb.onCommit(this.heights.slice());
    }, 300);
  }
  /** Disarm: flush any pending commit + hide the reticle. */
  end() {
    if (this.commitTimer) {
      clearTimeout(this.commitTimer);
      this.commitTimer = null;
    }
    this.host.hideReticle();
    this.cb.onCommit(this.heights.slice());
  }
};

// node_modules/@crit-fumble/shared/dist/constants/terrain-warnings.js
var HEIGHTMAP_WARNING_TITLE = "Add 3D terrain to this scene?";
var HEIGHTMAP_WARNING_BODY = "Heightmaps add a 3D terrain mesh to this scene. Players on lower-end machines may see slower rendering, and the cost grows with the size of the scene. We recommend skipping heightmaps on very large scenes with a lot of walls \u2014 those are the heaviest to render. You can remove the terrain later if it causes trouble.";
var HEIGHTMAP_WARNING_CONFIRM = "Add terrain";
var HEIGHTMAP_WARNING_ACK_KEY = "cfg.heightmapWarningAcknowledged";

// node_modules/@crit-fumble/shared/dist/constants/heightfield.js
var DEFAULT_SAMPLES_PER_SQUARE = 2;
var MAX_HEIGHTFIELD_DIM = 384;
function heightfieldDims(squaresX, squaresY, samplesPerSquare = DEFAULT_SAMPLES_PER_SQUARE) {
  const sx = Math.max(1, Math.floor(squaresX) || 1);
  const sy = Math.max(1, Math.floor(squaresY) || 1);
  let spp = Math.max(1, Math.floor(samplesPerSquare) || 1);
  while (spp > 1 && spp * Math.max(sx, sy) + 1 > MAX_HEIGHTFIELD_DIM)
    spp--;
  return {
    cols: Math.min(MAX_HEIGHTFIELD_DIM, spp * sx + 1),
    rows: Math.min(MAX_HEIGHTFIELD_DIM, spp * sy + 1),
    samplesPerSquare: spp
  };
}
function flatHeightfield(cols, rows) {
  return new Array(Math.max(0, cols * rows)).fill(0);
}
export {
  DEFAULT_SAMPLES_PER_SQUARE,
  HEIGHTMAP_WARNING_ACK_KEY,
  HEIGHTMAP_WARNING_BODY,
  HEIGHTMAP_WARNING_CONFIRM,
  HEIGHTMAP_WARNING_TITLE,
  MAX_HEIGHTFIELD_DIM,
  TerrainStampController,
  flatHeightfield,
  heightfieldDims,
  latticeAlignment,
  resampleHeightfield
};
