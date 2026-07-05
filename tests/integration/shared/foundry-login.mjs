/**
 * ensureInGame — bring a Playwright page into the running Foundry world as GM.
 *
 * Foundry permits a single active GM connection, and its session cookie does not
 * reliably survive being shared across separate browser contexts. So any test
 * context may land on the /join screen instead of in-game. This helper joins as
 * the Gamemaster when needed — Foundry kicks any stale prior connection for that
 * user, which (under the suite's workers:1 / sequential config) is exactly the
 * single-GM handoff we want — and resolves once the world reports ready.
 *
 * Used by globalSetup, the auth.setup project, and every spec's beforeEach, so
 * there is one join implementation rather than six copies.
 */
export async function ensureInGame(page) {
  await page.goto('/game')
  await page.waitForLoadState('domcontentloaded')

  // No session → Foundry 302s /game to /join. Pick a GM and submit. Foundry allows
  // concurrent users, so FOUNDRY_TEST_USER lets a headless run join as a DIFFERENT GM
  // (e.g. a service account) than a human who's connected — a substring match on the
  // user name; default is any Gamemaster/GM.
  if (page.url().includes('/join')) {
    const gmSelect = page.locator('select[name="userid"]')
    await gmSelect.waitFor({ timeout: 30_000 })
    const prefer = (process.env.FOUNDRY_TEST_USER || '').trim().toLowerCase()
    for (const opt of await gmSelect.locator('option').all()) {
      const value = await opt.getAttribute('value')
      const text = ((await opt.textContent()) || '').trim()
      if (!value) continue
      const match = prefer ? text.toLowerCase().includes(prefer) : /gamemaster|gm/i.test(text)
      if (match) {
        await gmSelect.selectOption(value)
        break
      }
    }
    // A fresh world's Gamemaster has no password.
    const pw = page.locator('input[name="password"]')
    if (await pw.count()) await pw.fill('')
    await page.locator('button[name="join"], button:has-text("Join Game")').first().click()
  }

  // dnd5e first paint can be slow; generous timeouts cover a cold join.
  await page.waitForSelector('#sidebar', { timeout: 90_000 })
  await page.waitForFunction(() => window.game?.ready, { timeout: 60_000 })
}
