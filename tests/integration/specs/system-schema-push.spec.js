/**
 * Descriptor push from a real world to a real Core server (dt#212).
 *
 * The sibling spec proves the descriptor extracted from real dnd5e is the shape the warnings
 * assume. This one proves that shape survives the wire: the server normalises what it is given
 * (caps, unknown-key stripping, `required` narrowed to declared fields), so a descriptor that is
 * correct in the browser can still arrive useless — and the push fails SILENTLY by design, which
 * makes the symptom "no warnings in the editor", not an error anyone would chase.
 *
 * Skips without `CORE_TEST_API_KEY` (`npm run test:foundry:provision`), like the other Core specs.
 */

import { test, expect } from '@playwright/test'
import { ensureInGame } from '../shared/foundry-login.mjs'
import { API_KEY } from '../shared/world-fixture.mjs'

const SYNC_URL = '/modules/crit-fumble-core/scripts/sync/system-schema-sync.js'

test.describe('System schema push to Core', () => {
  test.beforeEach(async ({ page }) => {
    await ensureInGame(page)
    await page.waitForFunction(() => window.CFGCore && game?.ready && game.system?.id === 'dnd5e', { timeout: 30_000 })
  })

  test('the real descriptor is accepted, and classIdentifier is on the wire', async ({ page }) => {
    test.skip(!API_KEY, 'Requires CORE_TEST_API_KEY')

    const { result, body } = await page.evaluate(async (url) => {
      const { syncSystemSchemas } = await import(url)
      // Capture what actually leaves the browser. A server that accepts the push tells us nothing
      // about whether the finding the feature exists for was in it.
      let sent = null
      const orig = window.fetch
      window.fetch = function (u, opts = {}) {
        if (String(u).includes('/api/v1/foundry/system-schema')) sent = opts.body
        return orig(u, opts)
      }
      try {
        const result = await syncSystemSchemas()
        return { result, body: sent ? JSON.parse(sent) : null }
      } finally {
        window.fetch = orig
      }
    }, SYNC_URL)

    expect(result.ok, `push rejected: ${result.reason ?? ''} ${result.status ?? ''}`).toBe(true)
    expect(result.count).toBeGreaterThan(0)

    const item = body.schemas.find((s) => s.documentClass === 'Item')
    expect(item.systemId).toBe('dnd5e')
    expect(item.types.subclass.requiredNonEmpty).toContain('classIdentifier')
    expect(item.types.class.fields).toContain('hd')
  })
})
