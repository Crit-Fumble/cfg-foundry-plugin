/**
 * Playwright globalSetup — runs once before all integration tests.
 *
 * 1. Waits for FoundryVTT to be ready (polls /api/status)
 * 2. Logs into Foundry as GM via headless Playwright browser
 * 3. Injects CFG module settings into the running world:
 *      coreApiUrl  — CORE_API_URL env var
 *      campaignId  — CORE_TEST_CAMPAIGN_ID env var
 *      apiKey      — CORE_TEST_API_KEY env var (self-hosted tests)
 * 4. Saves GM storage state so test projects skip re-login
 *
 * Env vars (from tests/.env.test):
 *   FOUNDRY_URL            — default http://localhost:30000
 *   CORE_API_URL           — Core server to test against
 *   CORE_TEST_CAMPAIGN_ID  — campaign ID to link the world to
 *   CORE_TEST_API_KEY      — cfk_ key for self-hosted tests
 */

import { chromium } from '@playwright/test'
import { mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const AUTH_DIR = join(__dirname, '../../.auth')
const AUTH_FILE = join(AUTH_DIR, 'foundry.json')

const FOUNDRY_URL = process.env.FOUNDRY_URL || 'http://localhost:30000'
const CORE_API_URL = process.env.CORE_API_URL || 'http://localhost:10001'
const CORE_TEST_CAMPAIGN = process.env.CORE_TEST_CAMPAIGN_ID || ''
const CORE_TEST_API_KEY = process.env.CORE_TEST_API_KEY || ''

const POLL_MS = 5_000
const TIMEOUT_MS = 180_000

const MODULE_ID = 'crit-fumble-core'

// ── Helpers ──────────────────────────────────────────────────────────────────

async function waitForFoundry() {
  const start = Date.now()
  console.log(`[globalSetup] Waiting for Foundry at ${FOUNDRY_URL}/api/status ...`)
  while (Date.now() - start < TIMEOUT_MS) {
    try {
      const res = await fetch(`${FOUNDRY_URL}/api/status`)
      if (res.ok) {
        console.log(`[globalSetup] Foundry ready (${Math.round((Date.now() - start) / 1000)}s)`)
        return
      }
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
    process.stdout.write('.')
  }
  throw new Error(`[globalSetup] Foundry did not become ready within ${TIMEOUT_MS / 1000}s`)
}

async function loginAsGM(page) {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')

  // Already in-game (e.g. reused session)? Done.
  if (await page.locator('#sidebar').count()) {
    console.log('[globalSetup] Already in game')
    return
  }

  // Join page (/join) — pick the Gamemaster user and submit. Foundry v14's join
  // form has no stable `#join-game` id, so key off the userid select directly.
  const gmSelect = page.locator('select[name="userid"]')
  await gmSelect.waitFor({ timeout: 30_000 })
  const options = await gmSelect.locator('option').all()
  for (const opt of options) {
    const value = await opt.getAttribute('value')
    const text = (await opt.textContent()) || ''
    if (value && /gamemaster|gm/i.test(text)) {
      await gmSelect.selectOption(value)
      break
    }
  }
  // Fresh world's Gamemaster has no password.
  const pw = page.locator('input[name="password"]')
  if (await pw.count()) await pw.fill('')
  await page.locator('button[name="join"], button:has-text("Join Game")').first().click()

  // dnd5e first-load can be slow (data migration), so allow generous timeouts.
  await page.waitForSelector('#sidebar', { timeout: 90_000 })
  await page.waitForFunction(() => window.game?.ready, { timeout: 60_000 })
  console.log('[globalSetup] Logged in as GM')
}

async function injectModuleSettings(page) {
  if (!CORE_TEST_CAMPAIGN) {
    console.warn('[globalSetup] CORE_TEST_CAMPAIGN_ID not set — skipping settings injection')
    return
  }

  await page.evaluate(
    ({ moduleId, apiUrl, campaignId, apiKey }) => {
      game.settings.set(moduleId, 'coreApiUrl', apiUrl)
      game.settings.set(moduleId, 'campaignId', campaignId)
      game.settings.set(moduleId, 'apiKey', apiKey)
    },
    { moduleId: MODULE_ID, apiUrl: CORE_API_URL, campaignId: CORE_TEST_CAMPAIGN, apiKey: CORE_TEST_API_KEY },
  )

  console.log(
    `[globalSetup] Module settings injected — campaign: ${CORE_TEST_CAMPAIGN}, apiKey: ${CORE_TEST_API_KEY ? '(set)' : '(none)'}`,
  )
}

// ── Main ─────────────────────────────────────────────────────────────────────

export default async function globalSetup() {
  await waitForFoundry()
  await mkdir(AUTH_DIR, { recursive: true })

  const browser = await chromium.launch()
  const context = await browser.newContext({ baseURL: FOUNDRY_URL })
  const page = await context.newPage()

  try {
    await loginAsGM(page)
    await injectModuleSettings(page)
    await context.storageState({ path: AUTH_FILE })
    console.log(`[globalSetup] Auth state saved to ${AUTH_FILE}`)

    // Foundry permits a single active GM connection. Leave the game cleanly so
    // the slot is free for the setup/test projects that reuse this auth state —
    // otherwise the next GM join races our still-open session and #sidebar never
    // appears. The session cookie (already saved above) stays valid for rejoin.
    await page.evaluate(() => globalThis.game?.logOut?.()).catch(() => {})
    await new Promise((r) => setTimeout(r, 3000))
  } finally {
    await browser.close()
  }
}
