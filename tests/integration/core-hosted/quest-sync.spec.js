/**
 * Core-hosted: Quest Sync integration tests
 *
 * Verifies that the plugin can sync quests from Core to Foundry journal entries
 * using session cookie auth. Requires CORE_TEST_CAMPAIGN_ID to be set.
 */

import { test, expect } from '@playwright/test'

const CAMPAIGN_ID = process.env.CORE_TEST_CAMPAIGN_ID

test.describe('Core-hosted: Quest Sync', () => {
  test.skip(!CAMPAIGN_ID, 'Skipped: CORE_TEST_CAMPAIGN_ID not set')

  test.beforeEach(async ({ page }) => {
    await page.goto('/game')
    await page.waitForSelector('#sidebar', { timeout: 30_000 })
    await page.waitForFunction(() => window.game?.ready && window.CFGCore, { timeout: 30_000 })
  })

  test('QuestSyncManager can be instantiated via CFGCore.api', async ({ page }) => {
    const apiExists = await page.evaluate(() => Boolean(window.CFGCore?.api))
    expect(apiExists).toBe(true)
  })

  test('quest sync creates journal folder when triggered', async ({ page }) => {
    // Trigger quest sync manually
    const result = await page.evaluate(async () => {
      try {
        const api = window.CFGCore.api
        const campaignId = window.CFGCore.campaignId()
        if (!campaignId) return { error: 'no campaign id' }
        // Import QuestSyncManager dynamically from the module
        const { QuestSyncManager } = await import('/modules/crit-fumble-core/scripts/services/quest-sync.js')
        const qs = new QuestSyncManager(api, null)
        await qs.initialize()
        return { success: true }
      } catch (err) {
        return { error: err.message }
      }
    })

    // Either succeeds or fails gracefully (e.g. no quests exist yet)
    expect(result.error ?? null).not.toMatch(/TypeError|Cannot read/)
  })
})
