/**
 * review-3d.mjs — dev tool: opens a HEADED browser on the live test Foundry (:30000),
 * logs in as GM, activates the CFG 3D Test scene, controls a token, and turns on the 3D
 * overlay in Character view — then STAYS OPEN for manual review. Close the window when done.
 *
 *   node tests/integration/review-3d.mjs
 */
import { chromium } from '@playwright/test'
import { ensureInGame } from './shared/foundry-login.mjs'

const URL = process.env.FOUNDRY_URL || 'http://localhost:30000'
const log = (...a) => console.log('[review]', ...a)

// The plugin's Playwright only has its headless shell; use the full Chromium that IS
// installed (a slightly newer build) via executablePath so a visible window can open.
const CHROME =
  process.env.REVIEW_CHROME ||
  '/Users/personal/Library/Caches/ms-playwright/chromium-1228/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
const browser = await chromium.launch({ headless: false, executablePath: CHROME, args: ['--start-maximized'] })
const page = await (await browser.newContext({ viewport: null, baseURL: URL })).newPage()

try {
  log('logging in as GM…')
  await ensureInGame(page)
  await page.evaluate(async () => {
    const s = game.scenes.find((x) => x.name === 'CFG 3D Test')
    if (s && !s.active) await s.activate()
  })
  await page.waitForFunction(() => globalThis.canvas?.ready === true, { timeout: 60_000 })
  await page.waitForFunction(() => !!window.CFGCore?.overlay3D, { timeout: 30_000 })
  await page.evaluate(async () => {
    canvas.tokens.activate()
    const t = canvas.tokens.placeables.find((x) => x.name?.startsWith('Center')) || canvas.tokens.placeables[0]
    t?.control({ releaseOthers: true })
    await window.CFGCore.overlay3D.setVisible(true)
    await new Promise((r) => setTimeout(r, 600))
    await ui.controls.activate({ control: 'cfg-3d', toggles: { topdown: true } }) // Character view
  })
  log('READY. Overlay is ON in CHARACTER view (3rd person).')
  log('  • Scroll to zoom 3rd↔1st person · move the mouse to aim the token · WASD to move.')
  log('  • Left toolbar "3D View" group: Top Down (Tactical) · Free Camera · Character · Slice.')
  log('  • The Foundry hotbar/sidebar stay usable over the 3D.')
  log('Leave this window open; close it when finished reviewing.')
  await new Promise(() => {}) // keep the browser open indefinitely
} catch (e) {
  log('SETUP FAILED:', e?.stack || e?.message || e)
  await new Promise(() => {}) // keep open so you can see the state / log in manually
}
