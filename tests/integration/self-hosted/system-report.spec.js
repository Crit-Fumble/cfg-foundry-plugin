/**
 * Self-hosted: System Report integration tests
 *
 * Verifies the plugin reports the Foundry game system to Core using API key auth.
 * Requires both CORE_TEST_API_KEY and CORE_TEST_CAMPAIGN_ID.
 */

import { test, expect } from '@playwright/test'

const API_KEY = process.env.CORE_TEST_API_KEY
const CAMPAIGN_ID = process.env.CORE_TEST_CAMPAIGN_ID

test.describe('Self-hosted: System Report', () => {
  test.skip(!API_KEY || !CAMPAIGN_ID, 'Skipped: CORE_TEST_API_KEY and CORE_TEST_CAMPAIGN_ID required')

  test.beforeEach(async ({ page }) => {
    await page.goto('/game')
    await page.waitForSelector('#sidebar', { timeout: 30_000 })
    await page.waitForFunction(() => window.game?.ready && window.CFGCore, { timeout: 30_000 })
  })

  test('CFGCore initializes with API key and returns a featureMode', async ({ page }) => {
    const cfg = await page.evaluate(() => ({
      featureMode: window.CFGCore?.featureMode?.(),
      hasApi: Boolean(window.CFGCore?.api),
      hasApiKey: Boolean(window.CFGCore?.api?.apiKey),
    }))

    expect(cfg.hasApi).toBe(true)
    expect(cfg.hasApiKey).toBe(true)
    expect(['full', 'narrative']).toContain(cfg.featureMode)
  })

  test('system report PATCH succeeds with API key auth', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const api = window.CFGCore?.api
      const campaignId = window.CFGCore?.campaignId?.()
      if (!api || !campaignId) return { error: 'not initialized' }
      try {
        const res = await api.patch(`/api/campaigns/${campaignId}/foundry`, {
          foundrySystemId: game.system.id,
        })
        return { success: true, featureMode: res?.featureMode ?? null }
      } catch (err) {
        return { error: err.message }
      }
    })

    expect(result.error ?? null).toBeNull()
    expect(result.success).toBe(true)
    expect(['full', 'narrative']).toContain(result.featureMode)
  })
})
