/**
 * Self-hosted: Quest Sync integration tests
 *
 * Verifies quest sync works with API key auth.
 * Requires CORE_TEST_API_KEY and CORE_TEST_CAMPAIGN_ID.
 */

import { test, expect } from '@playwright/test'
import { ensureInGame } from '../shared/foundry-login.mjs'

const API_KEY = process.env.CORE_TEST_API_KEY
const CAMPAIGN_ID = process.env.CORE_TEST_CAMPAIGN_ID

test.describe('Self-hosted: Quest Sync', () => {
  test.skip(!API_KEY || !CAMPAIGN_ID, 'Skipped: CORE_TEST_API_KEY and CORE_TEST_CAMPAIGN_ID required')

  test.beforeEach(async ({ page }) => {
    await ensureInGame(page)
    await page.waitForFunction(() => window.CFGCore, { timeout: 30_000 })
  })

  test('getQuests API call succeeds with API key', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const api = window.CFGCore?.api
      const campaignId = window.CFGCore?.campaignId?.()
      if (!api || !campaignId) return { error: 'not initialized' }
      try {
        const data = await api.getQuests(campaignId)
        return { success: true, isArray: Array.isArray(data?.quests ?? data) }
      } catch (err) {
        return { error: err.message }
      }
    })

    expect(result.error ?? null).toBeNull()
    expect(result.success).toBe(true)
  })
})
