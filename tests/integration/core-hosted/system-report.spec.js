/**
 * Core-hosted: System Report integration tests
 *
 * Verifies that the plugin correctly reports the Foundry game system to Core
 * and reads back featureMode when running in core-hosted mode (session cookies,
 * no API key).
 */

import { test, expect } from '@playwright/test'
import { ensureInGame } from '../shared/foundry-login.mjs'

test.describe('Core-hosted: System Report', () => {
  test.beforeEach(async ({ page }) => {
    await ensureInGame(page)
    await page.waitForFunction(() => window.CFGCore, { timeout: 30_000 })
  })

  test('CFGCore is exposed on window after ready', async ({ page }) => {
    const cfg = await page.evaluate(() => ({
      version: window.CFGCore?.version,
      featureMode: window.CFGCore?.featureMode?.(),
      campaignId: window.CFGCore?.campaignId?.(),
    }))

    expect(cfg.version).toBeTruthy()
    expect(['full', 'narrative']).toContain(cfg.featureMode)
    // campaignId may be null if CORE_TEST_CAMPAIGN_ID was not set
  })

  test('API client is initialized without API key (core-hosted mode)', async ({ page }) => {
    const apiKeySet = await page.evaluate(() => {
      const api = window.CFGCore?.api
      return api ? Boolean(api.apiKey) : null
    })

    expect(apiKeySet, 'Core-hosted mode should have no API key').toBe(false)
  })

  test('auth mode logged as core-hosted', async ({ page }) => {
    const logs = []
    page.on('console', (msg) => {
      if (msg.text().includes('CFG Core')) logs.push(msg.text())
    })

    await page.reload()
    await page.waitForSelector('#sidebar', { timeout: 30_000 })
    await page.waitForFunction(() => window.game?.ready, { timeout: 30_000 })

    const hasCoreModeLog = logs.some((l) => l.includes('core-hosted'))
    expect(hasCoreModeLog, 'Expected core-hosted auth mode log').toBe(true)
  })
})
