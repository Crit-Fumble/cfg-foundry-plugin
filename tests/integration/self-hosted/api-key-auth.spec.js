/**
 * Self-hosted: API Key Auth integration tests
 *
 * Verifies that the plugin sends the cfk_ API key as a Bearer token and
 * handles auth errors correctly when running in self-hosted mode.
 *
 * Requires CORE_TEST_API_KEY to be set in .env.test.
 */

import { test, expect } from '@playwright/test'

const API_KEY = process.env.CORE_TEST_API_KEY

test.describe('Self-hosted: API Key Auth', () => {
  test.beforeEach(async ({ page }) => {
    // Inject API key into module settings before the page loads
    if (API_KEY) {
      await page.goto('/game')
      await page.waitForSelector('#sidebar', { timeout: 30_000 })
      await page.waitForFunction(() => window.game?.ready, { timeout: 30_000 })
      await page.evaluate(([key]) => game.settings.set('crit-fumble-core', 'apiKey', key), [API_KEY])
      await page.reload()
      await page.waitForSelector('#sidebar', { timeout: 30_000 })
      await page.waitForFunction(() => window.game?.ready && window.CFGCore, { timeout: 30_000 })
    }
  })

  test.afterEach(async ({ page }) => {
    // Clear the API key so other test projects start clean
    await page.evaluate(() => game.settings.set('crit-fumble-core', 'apiKey', '').catch(() => {}))
  })

  test('CFGCore.api has apiKey set in self-hosted mode', async ({ page }) => {
    test.skip(!API_KEY, 'Skipped: CORE_TEST_API_KEY not set')
    const key = await page.evaluate(() => window.CFGCore?.api?.apiKey)
    expect(key).toBe(API_KEY)
  })

  test('auth mode logged as self-hosted', async ({ page }) => {
    test.skip(!API_KEY, 'Skipped: CORE_TEST_API_KEY not set')
    const logs = []
    page.on('console', (msg) => {
      if (msg.text().includes('CFG Core')) logs.push(msg.text())
    })
    await page.reload()
    await page.waitForSelector('#sidebar', { timeout: 30_000 })
    await page.waitForFunction(() => window.game?.ready, { timeout: 30_000 })
    const hasSelfHostedLog = logs.some((l) => l.includes('self-hosted'))
    expect(hasSelfHostedLog, 'Expected self-hosted auth mode log').toBe(true)
  })

  test('API request includes Authorization Bearer header', async ({ page }) => {
    test.skip(!API_KEY, 'Skipped: CORE_TEST_API_KEY not set')

    // Intercept fetch to verify the Authorization header is set
    const authHeader = await page.evaluate(
      async ([expectedKey]) => {
        let capturedHeader = null
        const origFetch = window.fetch
        window.fetch = function (url, opts = {}) {
          capturedHeader = opts.headers?.Authorization ?? opts.headers?.authorization ?? null
          window.fetch = origFetch // restore after first call
          return origFetch(url, opts)
        }
        // Trigger an API call
        const api = window.CFGCore?.api
        if (!api) return null
        try {
          await api.get('/api/config/platform').catch(() => {})
        } catch {
          /* ignore response errors */
        }
        return capturedHeader
      },
      [API_KEY],
    )

    expect(authHeader).toBe(`Bearer ${API_KEY}`)
  })

  test('invalid API key returns descriptive error message', async ({ page }) => {
    const errMsg = await page.evaluate(async () => {
      const { CoreAPIClient } = await import('/modules/crit-fumble-core/scripts/clients/api-client.js')
      const client = new CoreAPIClient(
        game.settings.get('crit-fumble-core', 'coreApiUrl'),
        'cfk_invalid_key_for_testing',
      )
      try {
        await client.get('/api/campaigns/nonexistent')
      } catch (err) {
        return err.message
      }
      return null
    })

    expect(errMsg).toMatch(/invalid|expired|api key/i)
  })
})
