/**
 * vtt-viewer-core.test.mjs — headless-browser test for the framework-agnostic 3D
 * viewer core (the shared render core, prototyped in the plugin for its proven infra).
 *
 * Bundles the core + three with esbuild, loads it in headless chromium, calls
 * loadScene(sceneJSON), and asserts the resulting three.js scene graph — the same
 * approach used for the Foundry overlay, but with NO Foundry (a plain scene JSON).
 *
 *   node tests/integration/vtt-viewer-core.test.mjs   (exit 0 = pass)
 */
import { chromium } from '@playwright/test'
import * as esbuild from 'esbuild'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CORE = join(__dirname, '../../scripts/lib/vtt-viewer/core.mjs')
const CHROME =
  process.env.REVIEW_CHROME ||
  '/Users/personal/Library/Caches/ms-playwright/chromium-1228/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'

const SCENE = {
  grid: { size: 100 },
  bounds: { width: 2000, height: 2000 },
  tokens: [
    { id: 'a', x: 500, y: 500, width: 100, height: 100, elevation: 0 },
    { id: 'b', x: 1000, y: 700, width: 100, height: 100, elevation: 20 },
    { id: 'c', x: 300, y: 1200, width: 200, height: 200, elevation: 0 },
  ],
  walls: [
    { id: 'w1', x1: 0, y1: 0, x2: 400, y2: 0, bottom: 0, top: 300 }, // horizontal → mid (200,150,0), h 300
    { id: 'w2', x1: 1000, y1: 500, x2: 1000, y2: 900, bottom: 0, top: 200 }, // vertical → mid (1000,100,700), h 200
  ],
}

const log = (...a) => console.log('[viewer-test]', ...a)
const fail = (m) => {
  console.error('[viewer-test] FAIL:', m)
  process.exitCode = 1
}

// Bundle the core + three into a single IIFE that exposes a global.
const built = await esbuild.build({
  stdin: {
    contents: `import * as THREE from 'three'; import { createViewer } from ${JSON.stringify(CORE)}; globalThis.CFGViewer = { createViewer, THREE };`,
    resolveDir: __dirname,
    loader: 'js',
  },
  bundle: true,
  format: 'iife',
  write: false,
  legalComments: 'none',
})
const bundle = built.outputFiles[0].text

const browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--enable-webgl'] })
const page = await (await browser.newContext({ viewport: { width: 1000, height: 800 } })).newPage()
page.on('pageerror', (e) => fail('pageerror: ' + e.message))
try {
  await page.setContent('<!doctype html><html><body><div id="v" style="width:800px;height:600px"></div></body></html>')
  await page.addScriptTag({ content: bundle })
  const g = await page.evaluate((scene) => {
    const v = window.CFGViewer.createViewer({ element: document.getElementById('v'), THREE: window.CFGViewer.THREE, width: 800, height: 600 })
    v.loadScene(scene)
    const sg = v.getSceneGraph()
    // a second load must not accumulate (dispose/clear the previous scene)
    v.loadScene(scene)
    return { first: sg, second: v.getSceneGraph() }
  }, SCENE)
  log('scene graph:', JSON.stringify(g.first))

  const byId = Object.fromEntries(g.first.tokens.map((t) => [t.id, t.pos]))
  if (g.first.tokenCount !== 3) fail(`expected 3 tokens, got ${g.first.tokenCount}`)
  if (!g.first.hasGround) fail('expected a ground plane')
  // token center = (x + w/2, elevation, y + h/2) in world (x, y=up, z)
  const near = (a, b) => Math.abs(a - b) <= 1
  const check = (id, x, y, z) => {
    const p = byId[id]
    if (!p || !near(p[0], x) || !near(p[1], y) || !near(p[2], z)) fail(`${id} at ${JSON.stringify(p)} != [${x},${y},${z}]`)
  }
  check('a', 550, 0, 550)
  check('b', 1050, 20, 750)
  check('c', 400, 0, 1300)
  if (g.second.tokenCount !== 3) fail(`reload accumulated tokens: ${g.second.tokenCount} (expected 3)`)

  // Walls: extruded at elevation, aligned to the segment (world x, y=up, z).
  if (g.first.wallCount !== 2) fail(`expected 2 walls, got ${g.first.wallCount}`)
  const w1 = g.first.walls[0]
  if (!w1 || !near(w1.pos[0], 200) || !near(w1.pos[1], 150) || !near(w1.pos[2], 0)) fail(`w1 at ${JSON.stringify(w1?.pos)} != [200,150,0]`)
  if (w1 && w1.height !== 300) fail(`w1 height ${w1.height} != 300 (extruded bottom→top)`)
  const w2 = g.first.walls[1]
  if (!w2 || !near(w2.pos[0], 1000) || !near(w2.pos[1], 100) || !near(w2.pos[2], 700)) fail(`w2 at ${JSON.stringify(w2?.pos)} != [1000,100,700]`)
  if (g.second.wallCount !== 2) fail(`reload accumulated walls: ${g.second.wallCount} (expected 2)`)

  if (!process.exitCode) log('PASS — viewer core renders a scene JSON (3 tokens + 2 walls-at-elevation + ground, reload-stable)')
} catch (e) {
  fail(e?.stack || e?.message || String(e))
} finally {
  await browser.close()
}
