/**
 * Quest sync — exercises a real per-campaign Core call (getQuests) against the
 * current v1 route. This is the regression guard for the api-client paths that
 * had drifted to the dead `/api/campaigns/...` shape; getQuests must hit
 * `/api/v1/player/campaigns/{id}/quests` and succeed for a linked campaign.
 */

import { test, expect } from '@playwright/test'
import { ensureInGame } from '../shared/foundry-login.mjs'
import { FIXTURE, API_KEY, useInstallation } from '../shared/world-fixture.mjs'

test.describe('Quest sync (self-hosted)', () => {
  test.skip(!FIXTURE || !API_KEY, 'Requires provisioned fixtures — run `npm run test:foundry:provision`')

  test.beforeEach(async ({ page }) => {
    await ensureInGame(page)
    await page.waitForFunction(() => window.CFGCore, { timeout: 30_000 })
    await useInstallation(page, FIXTURE.installations.single)
  })

  test('getQuests succeeds for a linked campaign via the v1 route', async ({ page }) => {
    const result = await page.evaluate(async (campaignId) => {
      try {
        const data = await window.CFGCore.api.getQuests(campaignId)
        return { ok: true, isArray: Array.isArray(data?.quests ?? data) }
      } catch (err) {
        return { error: err.message }
      }
    }, FIXTURE.campaigns.single)

    expect(result.error ?? null).toBeNull()
    expect(result.ok).toBe(true)
    expect(result.isArray).toBe(true)
  })
})
