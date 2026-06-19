/**
 * Self-hosted auth — when an API key is set, the plugin authenticates to Core
 * with `Authorization: Bearer cfk_...` (no session cookie). globalSetup injects
 * the key, so the module boots in self-hosted mode.
 */

import { test, expect } from '@playwright/test'
import { ensureInGame } from '../shared/foundry-login.mjs'
import { API_KEY } from '../shared/world-fixture.mjs'

test.describe('Self-hosted API key auth', () => {
  test.beforeEach(async ({ page }) => {
    await ensureInGame(page)
    await page.waitForFunction(() => window.CFGCore, { timeout: 30_000 })
  })

  test('CFGCore.api carries the API key in self-hosted mode', async ({ page }) => {
    test.skip(!API_KEY, 'Requires CORE_TEST_API_KEY')
    const key = await page.evaluate(() => window.CFGCore?.api?.apiKey)
    expect(key).toBe(API_KEY)
  })

  test('auth mode logs as self-hosted', async ({ page }) => {
    test.skip(!API_KEY, 'Requires CORE_TEST_API_KEY')
    const logs = []
    page.on('console', (msg) => {
      if (msg.text().includes('CFG Core')) logs.push(msg.text())
    })
    await page.reload()
    await page.waitForSelector('#sidebar', { timeout: 30_000 })
    await page.waitForFunction(() => window.game?.ready, { timeout: 30_000 })
    expect(logs.some((l) => l.includes('self-hosted'))).toBe(true)
  })

  test('requests send the Authorization Bearer header', async ({ page }) => {
    test.skip(!API_KEY, 'Requires CORE_TEST_API_KEY')
    const authHeader = await page.evaluate(async ([expectedKey]) => {
      let captured = null
      const orig = window.fetch
      window.fetch = function (url, opts = {}) {
        captured = opts.headers?.Authorization ?? opts.headers?.authorization ?? null
        window.fetch = orig
        return orig(url, opts)
      }
      try {
        await window.CFGCore.api.get('/api/v1/account/foundry/campaigns').catch(() => {})
      } catch {
        /* ignore response errors — we only care about the header */
      }
      return captured
    }, [API_KEY])
    expect(authHeader).toBe(`Bearer ${API_KEY}`)
  })

  test('an invalid API key surfaces a descriptive error', async ({ page }) => {
    const errMsg = await page.evaluate(async () => {
      const { CoreAPIClient } = await import('/modules/crit-fumble-core/scripts/clients/api-client.js')
      const client = new CoreAPIClient(game.settings.get('crit-fumble-core', 'coreApiUrl'), 'cfk_invalid_key_for_testing')
      try {
        await client.get('/api/v1/player/campaigns/nonexistent/quests')
      } catch (err) {
        return err.message
      }
      return null
    })
    expect(errMsg).toMatch(/invalid|expired|api key/i)
  })
})
