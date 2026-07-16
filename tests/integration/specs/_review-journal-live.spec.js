/**
 * REVIEW HARNESS (throwaway, not a CI assertion) — opens a headed Foundry so the
 * owner can SEE a note written on the platform arrive in the live world (#184).
 *
 * Nothing is stubbed: real Core server (:11001) → real plugin → real Foundry v14.
 * It deletes the note first, then reloads so JournalPullSync's first tick carries
 * it back in front of you. Opens the Journal sidebar and HOLDS THE BROWSER OPEN.
 *
 * Run (headed):
 *   npx playwright test --config tests/integration/playwright.config.js \
 *     --project=integration specs/_review-journal-live.spec.js --headed --workers=1
 */
import { test, expect } from '@playwright/test'
import { ensureInGame } from '../shared/foundry-login.mjs'
import { FIXTURE, useInstallation } from '../shared/world-fixture.mjs'

const CORE = 'http://localhost:11001'
const NOTE = 'The Sunken Library'

// Dock-safe: a 1080-tall window hides the bottom of the page behind the macOS
// dock. Same reasoning as dev/e2e-tests/helpers/review-viewport.ts.
test.use({ viewport: { width: 1600, height: 860 }, launchOptions: { args: ['--window-position=0,25'] } })

test('REVIEW — watch a PlayTable note land in the live Foundry world', async ({ page }) => {
  test.skip(!FIXTURE, 'needs `npm run test:foundry:provision`')
  test.setTimeout(0) // interactive — never time out

  await ensureInGame(page)
  await page.waitForFunction(() => window.CFGCore, { timeout: 30_000 })

  // Remove the Foundry-side copy so you watch a REAL first sync, not a leftover.
  // NB the server's FoundryJournalSync baseline must be cleared too, or the plan
  // comes back EMPTY — the server diffs against `lastPushedData` (what we believe
  // we wrote), never against the world, so it has no idea we deleted anything.
  // That gap is real and filed; this harness resets both sides out-of-band.
  await page.evaluate(async (name) => {
    for (const j of game.journal.filter((j) => j.name === name)) await j.delete()
  }, NOTE)

  await page.evaluate(async (core) => game.settings.set('crit-fumble-core', 'coreApiUrl', core), CORE)
  await useInstallation(page, FIXTURE.installations.single) // reload → first tick fires

  await expect
    .poll(async () => page.evaluate((n) => !!game.journal.find((j) => j.name === n), NOTE), { timeout: 60_000 })
    .toBe(true)

  // Open the Journal sidebar tab and the entry itself, so it's on screen.
  await page.evaluate(async (n) => {
    ui.sidebar?.changeTab?.('journal', 'primary')
    await game.journal.find((j) => j.name === n)?.sheet?.render(true)
  }, NOTE)

  console.log('\n  ✅ The note is in Foundry. Browser is open — close it when done.\n')

  // Hold open for the reviewer. Closing the window is the EXPECTED exit, so
  // swallow the resulting "target closed" — otherwise the harness reports
  // `1 failed` every single time you're done looking at it, which trains you to
  // ignore red. The assertions above have already passed by this point.
  await page.waitForTimeout(3_600_000).catch(() => {
    console.log('  (browser closed — review over)')
  })
})
