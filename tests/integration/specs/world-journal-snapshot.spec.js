/**
 * World→platform JOURNAL leg against a REAL FoundryVTT v14 world (dt#247, closes cs#186).
 *
 * The server half is unit- and integration-tested; what only a live world can settle is
 * whether the SOURCE of truth this whole design rests on actually exists and behaves:
 *
 *   1. Does `entry.toObject()` really carry `_stats.modifiedTime`? Every LWW decision in
 *      the programme is made against that number. If Foundry omitted it, `worldEditWins`
 *      would return false forever and the world could never win — silently.
 *   2. Does editing an entry actually ADVANCE that clock?
 *   3. Does the reconcile payload name exactly the entries the world still has, so a
 *      deleted entry is detectable at all?
 *
 * Transport is stubbed; the world is real.
 */

import { test, expect } from '@playwright/test'
import { ensureInGame } from '../shared/foundry-login.mjs'

const MODULE_URL = '/modules/crit-fumble-core/scripts/services/world-journal-snapshot.js'
const ENTRY_ID = 'CfgWJournalTs001'

async function seed(page) {
  return page.evaluate(async (id) => {
    for (const j of game.journal.filter((j) => j.id === id)) await j.delete()
    await JournalEntry.create(
      {
        _id: id,
        name: 'Field Notes',
        pages: [{ _id: 'pgWJournalTs0001', name: 'Overview', type: 'text', text: { format: 1, content: '<p>Original.</p>' } }],
      },
      { keepId: true },
    )
    return game.journal.get(id)?.toObject()?._stats?.modifiedTime ?? null
  }, ENTRY_ID)
}

/** Run one real full sweep and capture what the service would send. */
async function runSweep(page) {
  return page.evaluate(
    async ({ moduleUrl }) => {
      const { WorldJournalSnapshot } = await import(moduleUrl)
      const pushed = []
      const api = { pushWorldJournal: async (_w, body) => { pushed.push(body); return { ok: true } } }
      const svc = new WorldJournalSnapshot(api)
      await svc._fullSweep()
      return pushed
    },
    { moduleUrl: MODULE_URL },
  )
}

async function cleanup(page) {
  await page.evaluate(async (id) => {
    for (const j of game.journal.filter((j) => j.id === id)) await j.delete()
  }, ENTRY_ID)
}

test.describe('World journal snapshot against real Foundry', () => {
  test.beforeEach(async ({ page }) => {
    await ensureInGame(page)
    await page.waitForFunction(() => window.CFGCore && game?.ready, { timeout: 30_000 })
    await cleanup(page)
  })

  test.afterEach(async ({ page }) => {
    await cleanup(page)
  })

  test('sends the entry WITH `_stats.modifiedTime` — the clock every LWW call depends on', async ({ page }) => {
    await seed(page)
    const pushed = await runSweep(page)

    const batch = pushed.find((b) => Array.isArray(b.entries))
    expect(batch).toBeDefined()
    const doc = batch.entries.find((e) => e._id === ENTRY_ID)
    expect(doc).toBeDefined()
    // If this were ever absent, worldEditWins() would return false forever and the world
    // could never win — silently, which is exactly the cs#186 failure mode.
    expect(typeof doc._stats?.modifiedTime).toBe('number')
    expect(doc._stats.modifiedTime).toBeGreaterThan(0)
    expect(doc.pages[0].text.content).toBe('<p>Original.</p>')
  })

  test('a PAGE edit advances only the PAGE clock — the parent entry\'s does NOT move', async ({ page }) => {
    // The finding that forced `worldEditWinsDeep`. A journal's content lives in its pages,
    // so if the platform compared the entry clock alone it would lose every ordinary GM
    // edit — silently, which is exactly the cs#186 failure mode being fixed here.
    const before = await seed(page)
    await page.evaluate(async (id) => {
      const j = game.journal.get(id)
      await j.updateEmbeddedDocuments('JournalEntryPage', [
        { _id: 'pgWJournalTs0001', text: { format: 1, content: '<p>GM edited in Foundry.</p>' } },
      ])
    }, ENTRY_ID)

    const pushed = await runSweep(page)
    const doc = pushed.find((b) => Array.isArray(b.entries)).entries.find((e) => e._id === ENTRY_ID)

    expect(doc.pages[0].text.content).toBe('<p>GM edited in Foundry.</p>')
    // The parent is UNCHANGED — this is the trap.
    expect(doc._stats.modifiedTime).toBe(before)
    // The page moved, and it is carried in the payload so the server can see it.
    expect(doc.pages[0]._stats.modifiedTime).toBeGreaterThan(before)
  })

  test('a PARENT edit does advance the entry clock', async ({ page }) => {
    const before = await seed(page)
    await page.evaluate(async (id) => game.journal.get(id).update({ name: 'Renamed' }), ENTRY_ID)

    const pushed = await runSweep(page)
    const doc = pushed.find((b) => Array.isArray(b.entries)).entries.find((e) => e._id === ENTRY_ID)

    expect(doc.name).toBe('Renamed')
    expect(doc._stats.modifiedTime).toBeGreaterThan(before)
  })

  test('reconcile names the ids the world still has, so a delete is detectable', async ({ page }) => {
    await seed(page)
    let pushed = await runSweep(page)
    let recon = pushed.find((b) => b.reconcile === true)
    expect(recon.keepEntryIds).toContain(ENTRY_ID)

    // The GM deletes it. The reconcile payload is the ONLY signal — a deleted entry never
    // appears in a sync plan, because the server's baseline still matches the platform doc.
    await cleanup(page)
    pushed = await runSweep(page)
    recon = pushed.find((b) => b.reconcile === true)
    expect(recon).toBeDefined()
    expect(recon.keepEntryIds).not.toContain(ENTRY_ID)
  })
})
