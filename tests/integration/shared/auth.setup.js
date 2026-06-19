/**
 * Playwright auth setup — runs before test projects as the 'setup' dependency.
 *
 * Verifies GM session is valid and the game world is ready.
 * Storage state was saved by globalSetup; this just validates it loaded correctly.
 */

import { test as setup, expect } from '@playwright/test'
import { ensureInGame } from './foundry-login.mjs'

setup('verify GM session and world ready', async ({ page }) => {
  await ensureInGame(page)

  const isGM = await page.evaluate(() => game.user.isGM)
  const isReady = await page.evaluate(() => game.ready)

  expect(isReady).toBe(true)
  expect(isGM, 'Test must run as GM').toBe(true)

  // Verify the CFG module is active
  const moduleActive = await page.evaluate(() => game.modules.get('crit-fumble-core')?.active ?? false)
  expect(moduleActive, 'crit-fumble-core module must be active in the test world').toBe(true)
})
