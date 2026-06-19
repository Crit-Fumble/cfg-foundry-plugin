/**
 * World ↔ campaign links — the core of the world-centric model: a Foundry world
 * is associated with 0..N campaigns (and campaigns are optional). The plugin
 * resolves this via the N:M join, exposed as CFGCore.linkedCampaignIds().
 *
 * Each scenario points the plugin at a different Core installation (same world
 * folder), which resolves to a different set of campaign links — exercising:
 *   standalone → 0 campaigns (direct play, no platform campaign)
 *   single     → 1 campaign
 *   multi      → 2 campaigns sharing the one world
 */

import { test, expect } from '@playwright/test'
import { ensureInGame } from '../shared/foundry-login.mjs'
import { FIXTURE, API_KEY, useInstallation } from '../shared/world-fixture.mjs'

test.describe('World ↔ campaign links (N:M, optional)', () => {
  test.skip(!FIXTURE || !API_KEY, 'Requires provisioned fixtures — run `npm run test:foundry:provision`')

  test.beforeEach(async ({ page }) => {
    await ensureInGame(page)
    await page.waitForFunction(() => window.CFGCore, { timeout: 30_000 })
  })

  // linkedCampaignIds resolves asynchronously in the ready hook (Foundry flips
  // game.ready before the async handler finishes), so poll rather than read once.
  const linkedIds = (page) => page.evaluate(() => [...window.CFGCore.linkedCampaignIds()].sort())

  test('standalone world resolves zero linked campaigns and still plays', async ({ page }) => {
    await useInstallation(page, FIXTURE.installations.standalone)
    // No campaign required: a GM can grant world access directly and play.
    await expect.poll(() => linkedIds(page)).toEqual([])
    expect(['full', 'narrative']).toContain(await page.evaluate(() => window.CFGCore.featureMode()))
  })

  test('world linked to one campaign resolves exactly that campaign', async ({ page }) => {
    await useInstallation(page, FIXTURE.installations.single)
    await expect.poll(() => linkedIds(page)).toEqual([FIXTURE.campaigns.single])
  })

  test('one world shared across multiple campaigns resolves all of them', async ({ page }) => {
    await useInstallation(page, FIXTURE.installations.multi)
    await expect.poll(() => linkedIds(page)).toEqual([...FIXTURE.campaigns.multi].sort())
  })
})
