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

  // Join page — select GM and submit
  const joinForm = page.locator('form#join-game')
  if ((await joinForm.count()) > 0) {
    const gmSelect = page.locator('select[name="userid"]')
    if ((await gmSelect.count()) > 0) {
      const options = await gmSelect.locator('option').all()
      for (const opt of options) {
        const text = await opt.textContent()
        if (text?.toLowerCase().includes('gamemaster') || text?.toLowerCase().includes('gm')) {
          await gmSelect.selectOption(await opt.getAttribute('value'))
          break
        }
      }
    }
    const pw = page.locator('input[name="password"]')
    if (await pw.isVisible()) await pw.fill('')
    await page.locator('button[type="submit"], button:has-text("Join Game")').first().click()
  }

  await page.waitForSelector('#sidebar', { timeout: 45_000 })
  await page.waitForFunction(() => window.game?.ready, { timeout: 30_000 })
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
      game.settings.set(moduleId, 'autoSyncQuests', false) // disable auto-sync during setup
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
  } finally {
    await browser.close()
  }
}
