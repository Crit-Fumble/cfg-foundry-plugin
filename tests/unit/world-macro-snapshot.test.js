/**
 * World Macro snapshot (dt#214, slice 1).
 *
 * Covers the wire behaviour: a full sweep pushes every macro then a reconcile with the id set;
 * only the ELECTED reporter pushes (every GM sees the same game.macros, so an unelected client
 * must stay silent); and serialization sends the whole `toObject()` doc. The live-Foundry facts —
 * that `game.macros` and `macro.toObject()` behave this way — are verified in-world; here the
 * collection is mocked so the election + sweep logic is pinned without a Foundry.
 */

import { jest } from '@jest/globals'

async function loadSnapshot() {
  jest.resetModules()
  return await import('../../scripts/services/world-macro-snapshot.js')
}

/** A mock macro whose toObject returns its source. */
const macro = (id, over = {}) => ({
  id,
  toObject: () => ({ _id: id, name: `M-${id}`, type: 'chat', command: '/roll 1d20', scope: 'global', ...over }),
})

/** Wire up game with a macro collection + a GM user pool for the election. */
function setupGame({ macros = [], userId = 'gm1', gms = ['gm1'] } = {}) {
  const map = new Map(macros.map((m) => [m.id, m]))
  globalThis.game = {
    world: { id: 'test-world' },
    user: { id: userId, isGM: true },
    users: gms.map((id) => ({ id, active: true, isGM: true })),
    macros: { contents: macros, size: macros.length, get: (id) => map.get(id) },
  }
}

describe('WorldMacroSnapshot', () => {
  it('full sweep pushes every macro, then reconciles with the id set', async () => {
    setupGame({ macros: [macro('a'), macro('b')] })
    const { WorldMacroSnapshot } = await loadSnapshot()
    const calls = []
    const svc = new WorldMacroSnapshot({ pushWorldMacros: async (w, body) => { calls.push(body); return {} } })
    svc._running = true
    await svc._fullSweep()

    expect(calls[0].macros.map((m) => m._id)).toEqual(['a', 'b'])
    expect(calls[1]).toEqual({ reconcile: true, keepMacroIds: ['a', 'b'] })
  })

  it('sends the full toObject doc, including command/type/scope', async () => {
    setupGame({ macros: [macro('s1', { type: 'script', command: 'ui.notifications.info("x")', scope: 'actors' })] })
    const { WorldMacroSnapshot } = await loadSnapshot()
    let pushed = null
    const svc = new WorldMacroSnapshot({ pushWorldMacros: async (w, body) => { if (body.macros) pushed = body.macros[0]; return {} } })
    svc._running = true
    await svc._fullSweep()

    expect(pushed).toMatchObject({ _id: 's1', type: 'script', command: 'ui.notifications.info("x")', scope: 'actors' })
  })

  it('an UNELECTED reporter pushes nothing — no duplicate writes', async () => {
    // Two GMs; this client (gm2) is not the smallest id, so gm1 is the reporter.
    setupGame({ macros: [macro('a')], userId: 'gm2', gms: ['gm1', 'gm2'] })
    const { WorldMacroSnapshot } = await loadSnapshot()
    const calls = []
    const svc = new WorldMacroSnapshot({ pushWorldMacros: async (w, body) => { calls.push(body); return {} } })
    svc._running = true
    await svc._fullSweep()

    expect(calls).toEqual([])
  })

  it('a delta flush pushes only the changed macros', async () => {
    setupGame({ macros: [macro('a'), macro('b')] })
    const { WorldMacroSnapshot } = await loadSnapshot()
    const calls = []
    const svc = new WorldMacroSnapshot({ pushWorldMacros: async (w, body) => { calls.push(body); return {} } })
    svc._running = true
    svc._dirty.add('b')
    await svc._flushDeltas()

    expect(calls[0].macros.map((m) => m._id)).toEqual(['b'])
  })

  it('a delete schedules a reconcile that drops stale rows', async () => {
    setupGame({ macros: [macro('a')] })
    const { WorldMacroSnapshot } = await loadSnapshot()
    const calls = []
    const svc = new WorldMacroSnapshot({ pushWorldMacros: async (w, body) => { calls.push(body); return {} } })
    svc._running = true
    svc._needsReconcile = true
    await svc._flushDeltas()

    expect(calls).toEqual([{ reconcile: true, keepMacroIds: ['a'] }])
  })
})
