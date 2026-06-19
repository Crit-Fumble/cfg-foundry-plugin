/**
 * Shared accessors for the world-centric Core fixtures (provisioned by
 * `npm run test:foundry:provision`, surfaced via the CORE_TEST_FOUNDRY_FIXTURE
 * env var) and a helper to switch the plugin between linkage scenarios.
 *
 * FIXTURE shape:
 *   { worldId, installations: { standalone, single, multi }, campaigns: { single, multi: [a, b] } }
 *
 * The plugin's `installationId` setting (plus game.world.id) decides which Core
 * world — and therefore which campaign WorldAccessGrants — this Foundry world
 * resolves as linked. Switching it + reloading re-runs the ready hook, which is
 * how a single test world exercises the standalone / single / multi scenarios.
 */
export const FIXTURE = process.env.CORE_TEST_FOUNDRY_FIXTURE ? JSON.parse(process.env.CORE_TEST_FOUNDRY_FIXTURE) : null
export const API_KEY = process.env.CORE_TEST_API_KEY || ''

const MODULE_ID = 'crit-fumble-core'

/** Point the plugin at a given Core installation and reload so it re-resolves links. */
export async function useInstallation(page, installationId) {
  await page.evaluate(([mod, id]) => game.settings.set(mod, 'installationId', id), [MODULE_ID, installationId])
  await page.reload()
  await page.waitForSelector('#sidebar', { timeout: 90_000 })
  await page.waitForFunction(() => window.game?.ready && window.CFGCore, { timeout: 60_000 })
}
