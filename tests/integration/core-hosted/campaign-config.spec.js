/**
 * Core-hosted: Campaign Config integration tests
 *
 * Verifies module settings round-trip: values set in globalSetup are
 * readable via game.settings.get() and reflected in CFGCore state.
 */

import { test, expect } from '@playwright/test'

const MODULE_ID = 'crit-fumble-core'

test.describe('Core-hosted: Campaign Config', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/game')
    await page.waitForSelector('#sidebar', { timeout: 30_000 })
    await page.waitForFunction(() => window.game?.ready, { timeout: 30_000 })
  })

  test('coreApiUrl world setting is readable', async ({ page }) => {
    const url = await page.evaluate(([mod]) => game.settings.get(mod, 'coreApiUrl'), [MODULE_ID])
    expect(url).toBeTruthy()
    expect(url).toMatch(/^https?:\/\//)
  })

  test('campaignId world setting matches CORE_TEST_CAMPAIGN_ID env var', async ({ page }) => {
    const expected = process.env.CORE_TEST_CAMPAIGN_ID || ''
    if (!expected) return // skip assertion if not configured

    const id = await page.evaluate(([mod]) => game.settings.get(mod, 'campaignId'), [MODULE_ID])
    expect(id).toBe(expected)
  })

  test('apiKey world setting is empty in core-hosted mode', async ({ page }) => {
    const key = await page.evaluate(([mod]) => game.settings.get(mod, 'apiKey'), [MODULE_ID])
    expect(key).toBeFalsy()
  })

  test('CFGCore.campaignId() returns the configured campaign', async ({ page }) => {
    const expected = process.env.CORE_TEST_CAMPAIGN_ID || ''
    if (!expected) return

    const id = await page.evaluate(() => window.CFGCore?.campaignId?.())
    expect(id).toBe(expected)
  })
})
