/**
 * Journal pull-sync (#184 Phase 2) — the GM-side half that carries the platform's
 * party journal into the LIVE world.
 *
 * Covers the reporter election, the create/update split on the DERIVED id, page
 * reconciliation (including deletes, which a parent update cannot do), and the
 * ack contract the server baselines against.
 *
 * The keepId assertion is the load-bearing one. Foundry's default is
 * `keepId: false` and `common/abstract/document.mjs:483` does
 * `if (!keepId) delete data._id` — so without it the derived id is dropped, the
 * create-if-absent lookup never matches, and we'd duplicate the entire journal
 * every 30s forever.
 */

import { jest } from '@jest/globals'
import { JournalPullSync } from '../../scripts/services/journal-pull-sync.js'

/** Array-backed game.users collection that also exposes Foundry's `.get(id)`. */
function makeUsers(list) {
  const arr = [...list]
  arr.get = (id) => arr.find((u) => u.id === id)
  return arr
}

const ENTRY_ID = 'DerivedEntry0001'

const planItem = (over = {}) => ({
  journalEntryId: 'cjy_entry_1',
  foundryEntryId: ENTRY_ID,
  partyId: 'party-1',
  docData: {
    _id: ENTRY_ID,
    name: 'The Sunken Library',
    ownership: { default: 0, natAlice: 2 },
    sort: 0,
    pages: [{ _id: 'pageAAAAAAAAAAAA', name: 'Overview', type: 'text' }],
  },
  ...over,
})

function api(plan = []) {
  return {
    getJournalSyncPlan: jest.fn(async () => ({ data: plan })),
    ackJournalSync: jest.fn(async () => ({ data: { recorded: plan.length } })),
  }
}

/** A live JournalEntry with the given page ids. */
function liveEntry(pageIds = []) {
  return {
    pages: pageIds.map((id) => ({ id })),
    update: jest.fn(async () => {}),
    deleteEmbeddedDocuments: jest.fn(async () => {}),
    updateEmbeddedDocuments: jest.fn(async () => {}),
    createEmbeddedDocuments: jest.fn(async () => {}),
  }
}

/** game.journal.get() returning whatever the test seeds. */
function seedJournal(byId = {}) {
  globalThis.game.journal = { get: (id) => byId[id] ?? undefined }
}

beforeEach(() => {
  globalThis.JournalEntry = { create: jest.fn(async (d) => ({ id: d._id })) }
  // The engine health-probes through CONFIG.<Doc>.documentClass and deep-clones
  // via foundry.utils — both are ambient globals in a real Foundry client.
  globalThis.CONFIG = { JournalEntry: { documentClass: function JournalEntryClass() {} } }
  globalThis.foundry = { utils: { deepClone: (v) => JSON.parse(JSON.stringify(v)) } }
  globalThis.game = {
    world: { id: 'world-folder' },
    // The engine reads game.system.id (every real world has one); journals are
    // system-agnostic so the value never matters here.
    system: { id: 'cfg-test-system' },
    user: { id: 'gm-a', isGM: true },
    users: makeUsers([{ id: 'gm-a', active: true, isGM: true }]),
  }
  seedJournal({})
})

describe('JournalPullSync', () => {
  it('creates a missing entry with keepId so the derived id survives', async () => {
    const a = api([planItem()])
    await new JournalPullSync(a, 'inst-1').tick()

    expect(a.getJournalSyncPlan).toHaveBeenCalledWith('inst-1', 'world-folder')
    expect(JournalEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({ _id: ENTRY_ID, name: 'The Sunken Library' }),
      { keepId: true },
    )
  })

  it('acks success by ECHOING the doc it wrote', async () => {
    // The server baselines against this. Echoing (rather than letting the server
    // re-materialize) keeps the baseline honest if the entry changed platform-side
    // between the pull and the ack.
    const item = planItem()
    const a = api([item])
    await new JournalPullSync(a, 'inst-1').tick()

    expect(a.ackJournalSync).toHaveBeenCalledWith('inst-1', 'world-folder', [
      { journalEntryId: 'cjy_entry_1', foundryEntryId: ENTRY_ID, ok: true, docData: item.docData },
    ])
  })

  it('UPDATES in place when the entry already exists — never a second create', async () => {
    const existing = liveEntry(['pageAAAAAAAAAAAA'])
    seedJournal({ [ENTRY_ID]: existing })
    const a = api([planItem()])

    await new JournalPullSync(a, 'inst-1').tick()

    expect(JournalEntry.create).not.toHaveBeenCalled()
    // Entry-level fields only — pages are reconciled separately, and the engine
    // strips `_id` from an in-place update (it keys the lookup, not the write).
    expect(existing.update).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'The Sunken Library' }),
    )
    expect(existing.update.mock.calls[0][0]).not.toHaveProperty('_id')
    expect(existing.update.mock.calls[0][0]).not.toHaveProperty('pages')
  })

  it('DELETES a page removed on the platform', async () => {
    // The reason pages are reconciled explicitly: updating an embedded collection
    // through the parent merges by _id and never removes, so a deleted page would
    // linger in the world forever.
    const existing = liveEntry(['pageAAAAAAAAAAAA', 'pageSTALESTALE01'])
    seedJournal({ [ENTRY_ID]: existing })

    await new JournalPullSync(api([planItem()]), 'inst-1').tick()

    expect(existing.deleteEmbeddedDocuments).toHaveBeenCalledWith('JournalEntryPage', ['pageSTALESTALE01'])
    expect(existing.updateEmbeddedDocuments).toHaveBeenCalledWith('JournalEntryPage', [
      expect.objectContaining({ _id: 'pageAAAAAAAAAAAA' }),
    ])
  })

  it('creates a new page with keepId', async () => {
    const existing = liveEntry([]) // entry exists, page does not
    seedJournal({ [ENTRY_ID]: existing })

    await new JournalPullSync(api([planItem()]), 'inst-1').tick()

    expect(existing.createEmbeddedDocuments).toHaveBeenCalledWith(
      'JournalEntryPage',
      [expect.objectContaining({ _id: 'pageAAAAAAAAAAAA' })],
      { keepId: true },
    )
  })

  it('acks a failure without stopping the other entries', async () => {
    // NB: docData._id must be overridden too — `...over` only reaches top-level
    // keys, so a bare foundryEntryId override leaves the doc pointing at the
    // original id and the failure never fires.
    const bad = planItem({
      journalEntryId: 'cjy_bad',
      foundryEntryId: 'DerivedEntry0002',
      docData: { ...planItem().docData, _id: 'DerivedEntry0002' },
    })
    const good = planItem()
    JournalEntry.create = jest.fn(async (d) => {
      if (d._id === 'DerivedEntry0002') throw new Error('world rejected it')
      return { id: d._id }
    })
    const a = api([bad, good])

    await new JournalPullSync(a, 'inst-1').tick()

    const results = a.ackJournalSync.mock.calls[0][2]
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ journalEntryId: 'cjy_bad', ok: false, error: 'world rejected it' })
    expect(results[1]).toMatchObject({ journalEntryId: 'cjy_entry_1', ok: true })
  })

  it('does nothing — and does NOT ack — on an empty plan', async () => {
    // The steady state. An empty plan must cost one request, not a pointless POST.
    const a = api([])
    await new JournalPullSync(a, 'inst-1').tick()
    expect(JournalEntry.create).not.toHaveBeenCalled()
    expect(a.ackJournalSync).not.toHaveBeenCalled()
  })

  it('only the elected reporter works — a second GM stays quiet', async () => {
    game.user = { id: 'gm-b', isGM: true }
    game.users = makeUsers([
      { id: 'gm-a', active: true, isGM: true },
      { id: 'gm-b', active: true, isGM: true },
    ])
    const a = api([planItem()])
    await new JournalPullSync(a, 'inst-1').tick()
    expect(a.getJournalSyncPlan).not.toHaveBeenCalled() // 'gm-a' sorts first
  })

  it('the service-GM reports only when it is the SOLE gm', async () => {
    const SERVICE = 'CFGServiceGM0000'
    game.user = { id: SERVICE, isGM: true }
    game.users = makeUsers([{ id: SERVICE, active: true, isGM: true }])
    const a = api([planItem()])
    await new JournalPullSync(a, 'inst-1').tick()
    expect(a.getJournalSyncPlan).toHaveBeenCalled()

    // ...but yields the moment a human GM is present, even though 'C' sorts first.
    game.users = makeUsers([
      { id: SERVICE, active: true, isGM: true },
      { id: 'gm-human', active: true, isGM: true },
    ])
    const b = api([planItem()])
    await new JournalPullSync(b, 'inst-1').tick()
    expect(b.getJournalSyncPlan).not.toHaveBeenCalled()
  })

  it('a non-GM never pulls', async () => {
    game.user = { id: 'player-1', isGM: false }
    game.users = makeUsers([{ id: 'gm-a', active: true, isGM: true }])
    const a = api([planItem()])
    await new JournalPullSync(a, 'inst-1').tick()
    expect(a.getJournalSyncPlan).not.toHaveBeenCalled()
  })
})
