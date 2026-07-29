/**
 * World RollTable snapshot (dt#249).
 *
 * Covers the wire behaviour: a full sweep pushes every table (embedded results included)
 * then a reconcile with the id set; only the ELECTED reporter pushes; and — the genuinely
 * rolltable-specific part — an embedded TableResult change marks the PARENT table dirty,
 * because a row edit fires the result's hooks, not the parent's, and a table's content
 * lives in its rows. The live-Foundry facts are verified in-world; here the collection is
 * mocked so the election + sweep + parent-mapping logic is pinned without a Foundry.
 */

import { jest } from '@jest/globals'

async function loadSnapshot() {
  jest.resetModules()
  return await import('../../scripts/services/world-rolltable-snapshot.js')
}

/** A mock table whose toObject returns its source, results included. */
const table = (id, over = {}) => ({
  id,
  toObject: () => ({
    _id: id,
    name: `T-${id}`,
    formula: '1d2',
    results: [
      { _id: `${id}-r1`, type: 'text', text: 'first', range: [1, 1] },
      { _id: `${id}-r2`, type: 'text', text: 'second', range: [2, 2] },
    ],
    ...over,
  }),
})

/** Wire up game with a table collection + a GM user pool for the election. */
function setupGame({ tables = [], userId = 'gm1', gms = ['gm1'] } = {}) {
  const map = new Map(tables.map((t) => [t.id, t]))
  globalThis.game = {
    world: { id: 'test-world' },
    user: { id: userId, isGM: true },
    users: gms.map((id) => ({ id, active: true, isGM: true })),
    tables: { contents: tables, size: tables.length, get: (id) => map.get(id) },
  }
}

describe('WorldRollTableSnapshot', () => {
  it('full sweep pushes every table, then reconciles with the id set', async () => {
    setupGame({ tables: [table('a'), table('b')] })
    const { WorldRollTableSnapshot } = await loadSnapshot()
    const calls = []
    const svc = new WorldRollTableSnapshot({ pushWorldRollTables: async (w, body) => { calls.push(body); return {} } })
    svc._running = true
    await svc._fullSweep()

    expect(calls[0].tables.map((t) => t._id)).toEqual(['a', 'b'])
    expect(calls[1]).toEqual({ reconcile: true, keepTableIds: ['a', 'b'] })
  })

  it('sends the full toObject doc, embedded results included', async () => {
    setupGame({ tables: [table('s1')] })
    const { WorldRollTableSnapshot } = await loadSnapshot()
    let pushed = null
    const svc = new WorldRollTableSnapshot({ pushWorldRollTables: async (w, body) => { if (body.tables) pushed = body.tables[0]; return {} } })
    svc._running = true
    await svc._fullSweep()

    expect(pushed).toMatchObject({ _id: 's1', formula: '1d2' })
    expect(pushed.results).toHaveLength(2)
  })

  it('an UNELECTED reporter pushes nothing — no duplicate writes', async () => {
    // Two GMs; this client (gm2) is not the smallest id, so gm1 is the reporter.
    setupGame({ tables: [table('a')], userId: 'gm2', gms: ['gm1', 'gm2'] })
    const { WorldRollTableSnapshot } = await loadSnapshot()
    const calls = []
    const svc = new WorldRollTableSnapshot({ pushWorldRollTables: async (w, body) => { calls.push(body); return {} } })
    svc._running = true
    await svc._fullSweep()

    expect(calls).toEqual([])
  })

  it('a delta flush pushes only the changed tables', async () => {
    setupGame({ tables: [table('a'), table('b')] })
    const { WorldRollTableSnapshot } = await loadSnapshot()
    const calls = []
    const svc = new WorldRollTableSnapshot({ pushWorldRollTables: async (w, body) => { calls.push(body); return {} } })
    svc._running = true
    svc._dirty.add('b')
    await svc._flushDeltas()

    expect(calls[0].tables.map((t) => t._id)).toEqual(['b'])
  })

  it('an embedded TableResult change marks the PARENT table dirty', async () => {
    // A row edit fires create/update/deleteTableResult with the RESULT document; the
    // service must resolve result.parent and push the whole table, or ordinary row
    // edits would wait for the 15-minute sweep.
    setupGame({ tables: [table('a'), table('b')] })
    const { WorldRollTableSnapshot } = await loadSnapshot()
    const calls = []
    const svc = new WorldRollTableSnapshot({ pushWorldRollTables: async (w, body) => { calls.push(body); return {} } })
    svc._running = true

    const fakeResult = { id: 'a-r1', parent: game.tables.get('a') }
    svc._onChanged(fakeResult.parent) // what the TableResult hook handlers do
    await svc._flushDeltas()

    expect(calls[0].tables.map((t) => t._id)).toEqual(['a'])
  })

  it('a delete schedules a reconcile that drops stale rows', async () => {
    setupGame({ tables: [table('a')] })
    const { WorldRollTableSnapshot } = await loadSnapshot()
    const calls = []
    const svc = new WorldRollTableSnapshot({ pushWorldRollTables: async (w, body) => { calls.push(body); return {} } })
    svc._running = true
    svc._needsReconcile = true
    await svc._flushDeltas()

    expect(calls).toEqual([{ reconcile: true, keepTableIds: ['a'] }])
  })
})
