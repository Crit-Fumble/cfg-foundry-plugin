/**
 * World Scene snapshot (fp#48, slice 1).
 *
 * Covers the wire behaviour: a full sweep pushes every scene then a reconcile with the id set; only
 * the ELECTED reporter pushes (every GM sees the same game.scenes, so an unelected client must stay
 * silent); serialization sends the whole `toObject()` doc; and large collections BATCH (MAX_BATCH=10).
 * The live-Foundry facts (that `game.scenes` and `scene.toObject()` behave this way) are verified
 * in-world; here the collection is mocked so the election + sweep + batch logic is pinned without a
 * Foundry.
 */

import { jest } from '@jest/globals'

async function loadSnapshot() {
  jest.resetModules()
  return await import('../../scripts/services/world-scene-snapshot.js')
}

/** A mock scene whose toObject returns its source. */
const scene = (id, over = {}) => ({
  id,
  toObject: () => ({ _id: id, name: `S-${id}`, active: false, width: 4000, height: 4000, tokens: [], walls: [], ...over }),
})

/** Wire up game with a scene collection + a GM user pool for the election. */
function setupGame({ scenes = [], userId = 'gm1', gms = ['gm1'] } = {}) {
  const map = new Map(scenes.map((s) => [s.id, s]))
  globalThis.game = {
    world: { id: 'test-world' },
    user: { id: userId, isGM: true },
    users: gms.map((id) => ({ id, active: true, isGM: true })),
    scenes: { contents: scenes, size: scenes.length, get: (id) => map.get(id) },
  }
}

describe('WorldSceneSnapshot', () => {
  it('full sweep pushes every scene, then reconciles with the id set', async () => {
    setupGame({ scenes: [scene('a'), scene('b')] })
    const { WorldSceneSnapshot } = await loadSnapshot()
    const calls = []
    const svc = new WorldSceneSnapshot({ pushWorldScenes: async (w, body) => { calls.push(body); return {} } })
    svc._running = true
    await svc._fullSweep()

    expect(calls[0].scenes.map((s) => s._id)).toEqual(['a', 'b'])
    expect(calls[1]).toEqual({ reconcile: true, keepSceneIds: ['a', 'b'] })
  })

  it('sends the full toObject doc, including active + embedded collections', async () => {
    setupGame({ scenes: [scene('s1', { active: true, walls: [{ _id: 'w1' }], grid: { type: 1, size: 100 } })] })
    const { WorldSceneSnapshot } = await loadSnapshot()
    let pushed = null
    const svc = new WorldSceneSnapshot({ pushWorldScenes: async (w, body) => { if (body.scenes) pushed = body.scenes[0]; return {} } })
    svc._running = true
    await svc._fullSweep()

    expect(pushed).toMatchObject({ _id: 's1', active: true, walls: [{ _id: 'w1' }], grid: { type: 1, size: 100 } })
  })

  it('batches a large collection into MAX_BATCH=10 pushes', async () => {
    const many = Array.from({ length: 23 }, (_, i) => scene(`s${i}`))
    setupGame({ scenes: many })
    const { WorldSceneSnapshot } = await loadSnapshot()
    const batches = []
    const svc = new WorldSceneSnapshot({ pushWorldScenes: async (w, body) => { if (body.scenes) batches.push(body.scenes.length); return {} } })
    svc._running = true
    await svc._fullSweep()

    expect(batches).toEqual([10, 10, 3]) // 23 scenes → 10 + 10 + 3
  })

  it('an UNELECTED reporter pushes nothing — no duplicate writes', async () => {
    setupGame({ scenes: [scene('a')], userId: 'gm2', gms: ['gm1', 'gm2'] })
    const { WorldSceneSnapshot } = await loadSnapshot()
    const calls = []
    const svc = new WorldSceneSnapshot({ pushWorldScenes: async (w, body) => { calls.push(body); return {} } })
    svc._running = true
    await svc._fullSweep()

    expect(calls).toEqual([])
  })

  it('a delta flush pushes only the changed scenes', async () => {
    setupGame({ scenes: [scene('a'), scene('b')] })
    const { WorldSceneSnapshot } = await loadSnapshot()
    const calls = []
    const svc = new WorldSceneSnapshot({ pushWorldScenes: async (w, body) => { calls.push(body); return {} } })
    svc._running = true
    svc._dirty.add('b')
    await svc._flushDeltas()

    expect(calls[0].scenes.map((s) => s._id)).toEqual(['b'])
  })

  it('a delete schedules a reconcile that drops stale rows', async () => {
    setupGame({ scenes: [scene('a')] })
    const { WorldSceneSnapshot } = await loadSnapshot()
    const calls = []
    const svc = new WorldSceneSnapshot({ pushWorldScenes: async (w, body) => { calls.push(body); return {} } })
    svc._running = true
    svc._needsReconcile = true
    await svc._flushDeltas()

    expect(calls).toEqual([{ reconcile: true, keepSceneIds: ['a'] }])
  })
})
