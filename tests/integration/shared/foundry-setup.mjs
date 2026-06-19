#!/usr/bin/env node
/**
 * Bring the Foundry test world to an ACTIVE state from a fresh container.
 *
 * Mirrors what a hosted user does: accept the license agreement, then launch the
 * world. Foundry v14 won't activate a world until its EULA is signed (felddy
 * applies a license key on boot but the signature is per-acceptance), and a
 * never-launched world isn't auto-launched — it must be launched once (which
 * migrates it + creates the Gamemaster user). Both are driven via Playwright,
 * in a single Foundry process (no container restart — that races the data lock).
 *
 * Steps:
 *   1. Wait for Foundry to serve.
 *   2. If the world is already active → no-op (idempotent).
 *   3. Accept the EULA on /license (if prompted).
 *   4. Authenticate to /setup with FOUNDRY_ADMIN_KEY and launch the world,
 *      accepting the first-launch data-migration dialog.
 *   5. Wait for /api/status to report active.
 *
 * Run by `npm run test:foundry:up`, after `docker compose up -d`.
 */

import { chromium } from '@playwright/test'
import { readFileSync } from 'node:fs'

// The npm script only feeds tests/.env.test to `docker compose`, not to node,
// so load the few values we need (admin key, URL) here.
function loadEnvFile(path) {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/)
      if (!m || process.env[m[1]] !== undefined) continue
      let val = m[2]
      const quoted = val.match(/^(['"])(.*?)\1/)
      if (quoted) val = quoted[2] // value inside the quotes (ignore any trailing comment)
      else val = val.replace(/\s+#.*$/, '').trim() // unquoted: drop trailing comment + whitespace
      process.env[m[1]] = val
    }
  } catch {
    /* file optional */
  }
}
loadEnvFile(process.env.FOUNDRY_ENV_FILE || 'tests/.env.test')

const FOUNDRY_URL = process.env.FOUNDRY_URL || 'http://localhost:30000'
const ADMIN_KEY = process.env.FOUNDRY_ADMIN_KEY || ''
const WORLD_ID = process.env.FOUNDRY_WORLD || 'cfg-test-world'

async function status() {
  try {
    const res = await fetch(`${FOUNDRY_URL}/api/status`)
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

async function waitFor(pred, { label, timeoutMs = 180_000, everyMs = 5_000 }) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return
    process.stdout.write('.')
    await new Promise((r) => setTimeout(r, everyMs))
  }
  throw new Error(`[foundry-setup] timed out waiting for ${label} (${timeoutMs / 1000}s)`)
}

async function acceptEula(page) {
  await page.goto(`${FOUNDRY_URL}/license`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500) // let the form render (or redirect away if signed)
  if (!(await page.locator('#eula-agree').count())) {
    console.log('[foundry-setup] no license prompt (already signed)')
    return
  }
  await page.check('#eula-agree')
  await page.click('#sign')
  await page.waitForTimeout(3000) // signing redirects to /auth
  console.log('[foundry-setup] license agreement accepted')
}

async function launchWorld(page) {
  // /setup is admin-gated — authenticate first. Use a fixed settle wait: the
  // admin login submits + redirects, and networkidle can resolve before that
  // completes (leaving /setup unauthenticated with no worlds loaded).
  await page.goto(`${FOUNDRY_URL}/auth`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  if (await page.locator('#key').count()) {
    await page.fill('#key', ADMIN_KEY)
    await page.click('button[name=action]')
    await page.waitForTimeout(3000) // let the admin login submit + redirect settle
  }
  await page.goto(`${FOUNDRY_URL}/setup`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3500) // the world manager loads its package list async
  // The world tile + its launch button live in the DOM even when the Worlds tab
  // isn't the visible one and the button is only shown on hover — drive the click
  // through the DOM (Foundry's delegated data-action handler still fires).
  const launchSel = `[data-package-id="${WORLD_ID}"] [data-action="worldLaunch"]`
  const launched = await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return false
    el.click()
    return true
  }, launchSel)
  if (!launched) {
    const n = await page.evaluate(() => document.querySelectorAll('[data-package-id]').length)
    throw new Error(`[foundry-setup] world tile not found on /setup (${n} packages listed — admin auth likely failed)`)
  }
  // First launch migrates the world (core/system version) behind a confirm dialog.
  const confirm = page.locator(
    '.dialog button:has-text("Launch"), .dialog button.yes, button[data-action="yes"], button:has-text("Yes")',
  )
  try {
    await confirm.first().waitFor({ timeout: 8_000 })
    await confirm.first().click()
    console.log('[foundry-setup] confirmed migration dialog')
  } catch {
    /* no dialog — launched directly */
  }
  console.log('[foundry-setup] world launch requested')
}

console.log(`[foundry-setup] waiting for Foundry at ${FOUNDRY_URL} ...`)
await waitFor(async () => (await status()) !== null, { label: 'Foundry to serve' })

if ((await status())?.active) {
  console.log('[foundry-setup] world already active — nothing to do')
  process.exit(0)
}

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await acceptEula(page)
  await launchWorld(page)
} finally {
  await browser.close()
}

await waitFor(async () => (await status())?.active === true, { label: 'the world to become active' })
const final = await status()
console.log(`\n[foundry-setup] world active ✓ — ${final.world} (${final.system} ${final.systemVersion}) on Foundry ${final.version}`)
process.exit(0)
