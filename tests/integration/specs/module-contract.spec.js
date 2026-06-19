/**
 * CFGCore module contract — the window.CFGCore surface the rest of the plugin
 * (and these tests) rely on. Asserts the world-centric accessors exist and the
 * retired single-campaign setting stays retired. No linked campaign required.
 */

import { test, expect } from '@playwright/test'
import { ensureInGame } from '../shared/foundry-login.mjs'

const MODULE_ID = 'crit-fumble-core'

test.describe('CFGCore module contract', () => {
  test.beforeEach(async ({ page }) => {
    await ensureInGame(page)
    await page.waitForFunction(() => window.CFGCore, { timeout: 30_000 })
  })

  test('exposes version, api, and world-centric accessors', async ({ page }) => {
    const c = await page.evaluate(() => ({
      version: window.CFGCore.version,
      hasApi: Boolean(window.CFGCore.api),
      hostKind: window.CFGCore.hostKind(),
      featureMode: window.CFGCore.featureMode(),
      linkedIsArray: Array.isArray(window.CFGCore.linkedCampaignIds()),
    }))

    expect(c.version).toBeTruthy()
    expect(c.hasApi).toBe(true)
    expect(['cfg-hosted', 'self-hosted']).toContain(c.hostKind)
    expect(['full', 'narrative']).toContain(c.featureMode)
    // Worlds are linked to 0..N campaigns — the accessor is always a list.
    expect(c.linkedIsArray).toBe(true)
  })

  test('coreApiUrl setting is a valid URL', async ({ page }) => {
    const url = await page.evaluate(([mod]) => game.settings.get(mod, 'coreApiUrl'), [MODULE_ID])
    expect(url).toMatch(/^https?:\/\//)
  })

  test('the retired single-campaign `campaignId` setting is not registered', async ({ page }) => {
    // Guards against regressing to one-campaign-per-world: campaignId was
    // replaced by the N:M linkedCampaignIds(). Reading an unregistered setting
    // throws, so a clean read here would mean the legacy setting came back.
    const stillRegistered = await page.evaluate(([mod]) => {
      try {
        game.settings.get(mod, 'campaignId')
        return true
      } catch {
        return false
      }
    }, [MODULE_ID])
    expect(stillRegistered).toBe(false)
  })
})
