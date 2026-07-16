/**
 * Journal pull-sync against a REAL FoundryVTT v14 world (#184).
 *
 * The unit tests assert we CALL Foundry correctly; they cannot tell us whether
 * Foundry AGREES. Everything risky here is a contract with Foundry itself:
 *
 *   1. `{keepId: true}` really does preserve our DERIVED _id. If it didn't,
 *      `game.journal.get(derivedId)` would never match and we'd duplicate the
 *      whole journal every 30s forever. Mocks can't catch that — `JournalEntry`
 *      is stubbed, so it "passes" either way.
 *   2. The server's materialized doc VALIDATES against the real JournalEntry
 *      schema (name blank:false, ownership as DocumentOwnershipField, pages as an
 *      embedded collection). A shape mistake throws here and nowhere else.
 *   3. Page reconciliation actually creates/updates/DELETES embedded docs.
 *
 * Transport is stubbed, Foundry is real: we construct the REAL JournalPullSync
 * with a fake api returning a fixed plan, then inspect the live world. That keeps
 * this independent of the Core stack — no provisioning, no skip, and a failure
 * means Foundry disagrees with us rather than "the fixtures aren't seeded".
 */

import { test, expect } from '@playwright/test'
import { ensureInGame } from '../shared/foundry-login.mjs'

const MODULE_URL = '/modules/crit-fumble-core/scripts/services/journal-pull-sync.js'

// Foundry's DocumentIdField requires exactly 16 alphanumerics — the same shape
// deriveFoundryEntryId emits server-side.
const ENTRY_ID = 'CfgJournalTest01'
const PAGE_A = 'CfgJournalPageA1'
const PAGE_B = 'CfgJournalPageB1'

/** A plan item shaped exactly like the server's materializeJournalDocForWorld output. */
function planItem({ pages, ownership, name = 'The Sunken Library' } = {}) {
  return {
    journalEntryId: 'cjy_live_1',
    foundryEntryId: ENTRY_ID,
    partyId: 'party-live',
    docData: {
      _id: ENTRY_ID,
      name,
      ownership: ownership ?? { default: 2 },
      sort: 0,
      folder: null,
      flags: { playtable: { sourceJournalEntryId: 'cjy_live_1' } },
      pages: pages ?? [
        {
          _id: PAGE_A,
          name: 'Overview',
          type: 'text',
          title: { show: false, level: 1 },
          sort: 0,
          text: { format: 1, content: '<p>Flooded.</p>' },
        },
      ],
    },
  }
}

/** Drive ONE real tick of the real service against the live world. */
async function runTick(page, plan) {
  return page.evaluate(
    async ({ plan, moduleUrl }) => {
      const { JournalPullSync } = await import(moduleUrl)
      const acked = []
      const api = {
        getJournalSyncPlan: async () => ({ data: plan }),
        ackJournalSync: async (_inst, _world, results) => {
          acked.push(...results)
          return { data: { recorded: results.length } }
        },
      }
      await new JournalPullSync(api, 'inst-live-test').tick()

      const doc = game.journal.get(plan[0].foundryEntryId)
      // Read flags RAW, never via getFlag: Foundry validates the scope against
      // active module ids (common/abstract/document.mjs:952-954) and our scope is
      // `playtable` while the module id is `crit-fumble-core` — getFlag THROWS.
      // Writing via document data is unvalidated, which is why the sync works.
      const sourceOf = (j) => j.flags?.playtable?.sourceJournalEntryId
      return {
        acked,
        found: !!doc,
        name: doc?.name ?? null,
        ownership: doc ? foundry.utils.deepClone(doc.ownership) : null,
        pageIds: doc ? doc.pages.map((p) => p.id).sort() : [],
        pageNames: doc ? doc.pages.map((p) => p.name) : [],
        sourceFlag: doc ? sourceOf(doc) : null,
        // How many entries carry our source flag — the duplicate detector.
        sourceCount: game.journal.filter((j) => sourceOf(j) === 'cjy_live_1').length,
      }
    },
    { plan, moduleUrl: MODULE_URL },
  )
}

async function cleanup(page) {
  await page.evaluate(async (id) => {
    const doc = game.journal.get(id)
    if (doc) await doc.delete()
  }, ENTRY_ID)
}

test.describe('Journal pull-sync against real Foundry', () => {
  test.beforeEach(async ({ page }) => {
    await ensureInGame(page)
    await page.waitForFunction(() => window.CFGCore && game?.ready, { timeout: 30_000 })
    await cleanup(page) // a prior failed run must not poison this one
  })

  test.afterEach(async ({ page }) => {
    await cleanup(page)
  })

  test('creates the entry under our DERIVED id — keepId holds against real Foundry', async ({ page }) => {
    const res = await runTick(page, [planItem()])

    // The load-bearing assertion. Foundry defaults keepId=false and deletes _id;
    // if our option were dropped, this lookup would miss and the entry would exist
    // under a random id instead.
    expect(res.found).toBe(true)
    expect(res.name).toBe('The Sunken Library')
    expect(res.pageIds).toEqual([PAGE_A])
    expect(res.pageNames).toEqual(['Overview'])
    // The doc validated — real schema, real ownership field.
    expect(res.ownership).toMatchObject({ default: 2 })
    // Provenance survives the round-trip. NB readable only as raw data — see runTick.
    expect(res.sourceFlag).toBe('cjy_live_1')
    expect(res.acked).toEqual([
      expect.objectContaining({ journalEntryId: 'cjy_live_1', foundryEntryId: ENTRY_ID, ok: true }),
    ])
  })

  test('a second tick UPDATES in place — it does not duplicate', async ({ page }) => {
    await runTick(page, [planItem()])
    const res = await runTick(page, [planItem({ name: 'The Drained Library' })])

    // The failure mode keepId protects against: one entry, renamed — not two.
    expect(res.sourceCount).toBe(1)
    expect(res.name).toBe('The Drained Library')
  })

  test('propagates a page ADD and a page DELETE', async ({ page }) => {
    const twoPages = planItem({
      pages: [
        ...planItem().docData.pages,
        { _id: PAGE_B, name: 'Secrets', type: 'text', title: { show: false, level: 1 }, sort: 1, text: { format: 1, content: '<p>Shh.</p>' } },
      ],
    })
    const after = await runTick(page, [twoPages])
    expect(after.pageIds).toEqual([PAGE_A, PAGE_B].sort())

    // Drop page B platform-side. A parent update MERGES by _id and never removes,
    // so this only passes because pages are reconciled explicitly.
    const dropped = await runTick(page, [planItem()])
    expect(dropped.pageIds).toEqual([PAGE_A])
  })

  test('accepts a per-user ownership key for a REAL world user', async ({ page }) => {
    // The server materializes native user ids from UserGameWorldAccess.nativeUserId.
    // This proves Foundry accepts that shape for a user that exists in the world.
    const gmId = await page.evaluate(() => game.user.id)
    const res = await runTick(page, [planItem({ ownership: { default: 0, [gmId]: 3 } })])

    expect(res.found).toBe(true)
    expect(res.ownership).toMatchObject({ default: 0, [gmId]: 3 })
  })
})
