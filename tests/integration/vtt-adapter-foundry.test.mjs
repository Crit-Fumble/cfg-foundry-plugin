/**
 * vtt-adapter-foundry.test.mjs — proves the "same file data" path end-to-end:
 * a plain Foundry-scene-shaped object → foundrySceneToViewer() → the framework-agnostic
 * viewer core → rendered three.js scene graph, in headless chromium, with NO Foundry
 * runtime. This is what PlayTable (or any surface) does with a stored scene JSON.
 *
 *   node tests/integration/vtt-adapter-foundry.test.mjs   (exit 0 = pass)
 */
import { chromium } from '@playwright/test'
import * as esbuild from 'esbuild'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CORE = join(__dirname, '../../scripts/lib/vtt-viewer/core.mjs')
const ADAPTER = join(__dirname, '../../scripts/lib/vtt-viewer/adapter-foundry.mjs')
const CHROME =
  process.env.REVIEW_CHROME ||
  '/Users/personal/Library/Caches/ms-playwright/chromium-1228/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'

// A plain object shaped like a Foundry Scene doc (grid 100px = 5ft → 20px/ft).
const FOUNDRY_SCENE = {
  grid: { size: 100, distance: 5 },
  width: 3000,
  height: 3000,
  backgroundColor: '#223044',
  tokens: [
    { _id: 't1', x: 500, y: 500, width: 1, height: 1, elevation: 0, disposition: 1 }, // 1×1 grid → 100px
    { _id: 't2', x: 1000, y: 800, width: 2, height: 2, elevation: 10, disposition: -1 }, // 2×2 → 200px, +10ft → 200px up
  ],
  walls: [
    { _id: 'w1', c: [0, 0, 500, 0] }, // no wall-height → default 2-grid tall = 200px
    { _id: 'w2', c: [1000, 0, 1000, 500], flags: { 'wall-height': { bottom: 0, top: 30 } } }, // 30ft → 600px
  ],
}

const log = (...a) => console.log('[adapter-test]', ...a)
const fail = (m) => {
  console.error('[adapter-test] FAIL:', m)
  process.exitCode = 1
}

const built = await esbuild.build({
  stdin: {
    contents: `import * as THREE from 'three'; import { createViewer } from ${JSON.stringify(CORE)}; import { foundrySceneToViewer } from ${JSON.stringify(ADAPTER)}; globalThis.CFG = { createViewer, foundrySceneToViewer, THREE };`,
    resolveDir: __dirname,
    loader: 'js',
  },
  bundle: true,
  format: 'iife',
  write: false,
  legalComments: 'none',
})

const browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--enable-webgl'] })
const page = await (await browser.newContext({ viewport: { width: 1000, height: 800 } })).newPage()
page.on('pageerror', (e) => fail('pageerror: ' + e.message))
try {
  await page.setContent('<!doctype html><html><body><div id="v" style="width:800px;height:600px"></div></body></html>')
  await page.addScriptTag({ content: built.outputFiles[0].text })
  const out = await page.evaluate((fscene) => {
    const viewerJson = window.CFG.foundrySceneToViewer(fscene)
    const v = window.CFG.createViewer({ element: document.getElementById('v'), THREE: window.CFG.THREE, width: 800, height: 600 })
    v.loadScene(viewerJson)
    return { viewerJson, sg: v.getSceneGraph() }
  }, FOUNDRY_SCENE)
  log('viewer JSON:', JSON.stringify(out.viewerJson))
  log('scene graph:', JSON.stringify(out.sg))

  const j = out.viewerJson
  const near = (a, b) => Math.abs(a - b) <= 1
  // --- adapter conversions ---
  if (j.grid?.size !== 100) fail(`grid.size ${j.grid?.size} != 100`)
  if (!near(j.bounds?.width, 3000)) fail(`bounds.width ${j.bounds?.width} != 3000`)
  const t2 = j.tokens.find((t) => t.id === 't2')
  if (!t2 || !near(t2.width, 200) || !near(t2.height, 200)) fail(`t2 size ${t2?.width}×${t2?.height} != 200×200 (grid units → px)`)
  if (!t2 || !near(t2.elevation, 200)) fail(`t2 elevation ${t2?.elevation} != 200 (10ft × 20px/ft)`)
  const w2 = j.walls.find((w) => w.id === 'w2')
  if (!w2 || !near(w2.top, 600)) fail(`w2.top ${w2?.top} != 600 (30ft × 20px/ft)`)
  const w1 = j.walls.find((w) => w.id === 'w1')
  if (!w1 || !near(w1.top, 200)) fail(`w1.top ${w1?.top} != 200 (default 2-grid)`)

  // --- rendered scene graph (adapter → core) ---
  const byId = Object.fromEntries(out.sg.tokens.map((t) => [t.id, t.pos]))
  const check = (id, x, y, z) => {
    const p = byId[id]
    if (!p || !near(p[0], x) || !near(p[1], y) || !near(p[2], z)) fail(`${id} rendered at ${JSON.stringify(p)} != [${x},${y},${z}]`)
  }
  if (out.sg.tokenCount !== 2) fail(`tokenCount ${out.sg.tokenCount} != 2`)
  check('t1', 550, 0, 550) // 500+50, elev 0
  check('t2', 1100, 200, 900) // 1000+100, elev 200, 800+100
  if (out.sg.wallCount !== 2) fail(`wallCount ${out.sg.wallCount} != 2`)

  if (!process.exitCode) log('PASS — Foundry scene → adapter → viewer core renders correctly (grid-units, elevation, wall-height all converted)')
} catch (e) {
  fail(e?.stack || e?.message || String(e))
} finally {
  await browser.close()
}
