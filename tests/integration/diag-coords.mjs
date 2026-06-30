/**
 * diag-coords.mjs — dump live coordinate alignment + UI layering so we can
 * confirm (a) tokens/walls/ground share the same origin and (b) the Foundry UI
 * still renders over the 3D overlay.
 *   node tests/integration/diag-coords.mjs
 */
import { chromium } from '@playwright/test'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { ensureInGame } from './shared/foundry-login.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = join(__dirname, '../test-results')

const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, baseURL: 'http://localhost:30000' })
const page = await ctx.newPage()

await ensureInGame(page)
await page.waitForFunction(() => globalThis.canvas?.ready === true, { timeout: 60_000 })
await page.waitForFunction(() => !!window.CFGCore?.overlay3D, { timeout: 30_000 })

const data = await page.evaluate(async () => {
  const inst = window.CFGCore.overlay3D._instance
  await window.CFGCore.overlay3D.setVisible(true)
  await new Promise((r) => setTimeout(r, 1500))
  const d = canvas.dimensions
  const R = (n) => Math.round(n)

  const coords = {
    dims: { width: d.width, height: d.height, sceneX: d.sceneX, sceneY: d.sceneY, sceneWidth: d.sceneWidth, sceneHeight: d.sceneHeight, size: d.size, distance: d.distance },
    overlayFrame: inst._frame,
    groundCenter: inst._ground ? [R(inst._ground.position.x), R(inst._ground.position.z)] : null,
    tokens: canvas.tokens.placeables.map((t) => ({
      name: t.name,
      docXY: [t.document.x, t.document.y],
      center: [R(t.center.x), R(t.center.y)],
      groupXZ: inst._tokens.get(t.id) ? [R(inst._tokens.get(t.id).position.x), R(inst._tokens.get(t.id).position.z)] : null,
    })),
    walls: canvas.walls.placeables.map((w) => ({ c: w.document.c, mid: [(w.document.c[0] + w.document.c[2]) / 2, (w.document.c[1] + w.document.c[3]) / 2] })),
  }

  const ui = {}
  for (const sel of ['#board', '#interface', '#hud', '#ui', '#ui-left', '#ui-right', '#ui-top', '#ui-bottom', '#sidebar', '#controls', '#scene-controls', '#hotbar', '#players', '#navigation', '#cfg-3d-overlay']) {
    const el = document.querySelector(sel)
    if (!el) { ui[sel] = null; continue }
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    ui[sel] = { z: cs.zIndex, position: cs.position, display: cs.display, visible: r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden', rect: [R(r.x), R(r.y), R(r.width), R(r.height)] }
  }

  const boardChain = []
  let el = document.getElementById('board')
  while (el && el !== document.body) { boardChain.push({ id: el.id || el.tagName.toLowerCase(), z: getComputedStyle(el).zIndex, pos: getComputedStyle(el).position }); el = el.parentElement }

  return { coords, ui, boardChain, overlayParent: inst._container?.parentElement?.id || inst._container?.parentElement?.tagName }
})

console.log(JSON.stringify(data, null, 2))
await page.screenshot({ path: join(OUT, 'diag-ui-over-3d.png') })
await browser.close()
