/**
 * World Actor snapshot — live folder-edit hooks (cs#195 follow-up).
 *
 * The full sweep mirrors the world's folders (see `_sweepFolders`) — since dt#250
 * for EVERY mirrored document type, not just Actor. A folder rename/move/delete in
 * a live world rides the createFolder/updateFolder/deleteFolder hooks: they mark
 * folders dirty and a debounced delta flush re-sweeps folders — while an UNELECTED
 * reporter still stays silent, and a folder of an unmirrored type (e.g. the
 * 'Compendium' sidebar grouping) is ignored.
 *
 * The live-Foundry facts (that the *Folder hooks fire with the Folder doc, and that
 * `folder.toObject()` behaves this way) are verified in-world; here Hooks + the
 * collections are mocked so the election + dirty-tracking logic is pinned.
 */

import { jest } from '@jest/globals'

async function loadSnapshot() {
  jest.resetModules()
  return await import('../../scripts/services/world-actor-snapshot.js')
}

/** A mock Actor folder whose toObject returns its source. */
const folder = (id, type = 'Actor', over = {}) => ({
  id,
  type,
  toObject: () => ({ _id: id, name: `F-${id}`, type, folder: null, sort: 0, ...over }),
})

const actor = (id) => ({ id, toObject: () => ({ _id: id, name: `A-${id}` }) })

/** Capture Hooks.on registrations so start()'s wiring can be asserted + invoked. */
function setupGame({ actors = [], folders = [], userId = 'gm1', gms = ['gm1'] } = {}) {
  const amap = new Map(actors.map((a) => [a.id, a]))
  const registered = {}
  globalThis.Hooks = {
    on: (name, fn) => { (registered[name] ||= []).push(fn) },
    off: () => {},
  }
  globalThis.game = {
    world: { id: 'test-world' },
    system: { id: 'dnd5e' },
    user: { id: userId, isGM: true },
    users: gms.map((id) => ({ id, active: true, isGM: true })),
    actors: { contents: actors, size: actors.length, get: (id) => amap.get(id) },
    folders: { contents: folders },
  }
  return registered
}

/** A fake api-client recording folder pushes. */
function fakeApi(calls) {
  return {
    pushWorldActors: async () => ({}),
    pushWorldFolders: async (w, body) => { calls.push(body); return {} },
  }
}

describe('WorldActorSnapshot — folder-edit hooks', () => {
  it('start() registers createFolder / updateFolder / deleteFolder hooks', async () => {
    const registered = setupGame({})
    const { WorldActorSnapshot } = await loadSnapshot()
    const svc = new WorldActorSnapshot(fakeApi([]))
    svc.start()
    expect(registered.createFolder?.length).toBe(1)
    expect(registered.updateFolder?.length).toBe(1)
    expect(registered.deleteFolder?.length).toBe(1)
    svc.stop()
  })

  it('an Actor-folder edit marks folders dirty and schedules a flush', async () => {
    setupGame({})
    const { WorldActorSnapshot } = await loadSnapshot()
    const svc = new WorldActorSnapshot(fakeApi([]))
    svc._running = true
    svc._onFolderChanged(folder('f1', 'Actor'))
    expect(svc._foldersDirty).toBe(true)
    expect(svc._debounceHandle).not.toBeNull()
    svc.stop()
  })

  it('a folder edit of ANY mirrored document type marks folders dirty (dt#250)', async () => {
    setupGame({})
    const { WorldActorSnapshot } = await loadSnapshot()
    for (const type of ['Item', 'JournalEntry', 'Macro', 'Playlist', 'RollTable', 'Cards', 'Scene']) {
      const svc = new WorldActorSnapshot(fakeApi([]))
      svc._running = true
      svc._onFolderChanged(folder('x1', type))
      expect(svc._foldersDirty).toBe(true)
      svc.stop()
    }
  })

  it('ignores folder edits of unmirrored types (Compendium sidebar grouping)', async () => {
    setupGame({})
    const { WorldActorSnapshot } = await loadSnapshot()
    const svc = new WorldActorSnapshot(fakeApi([]))
    svc._running = true
    svc._onFolderChanged(folder('c1', 'Compendium'))
    expect(svc._foldersDirty).toBe(false)
    expect(svc._debounceHandle).toBeNull()
  })

  it('the sweep pushes every mirrored type and skips unmirrored ones (dt#250)', async () => {
    setupGame({
      folders: [
        folder('fa', 'Actor'),
        folder('fj', 'JournalEntry'),
        folder('fs', 'Scene'),
        folder('fc', 'Compendium'), // sidebar pack grouping — never pushed
      ],
    })
    const { WorldActorSnapshot } = await loadSnapshot()
    const calls = []
    const svc = new WorldActorSnapshot(fakeApi(calls))
    svc._running = true
    await svc._sweepFolders()

    expect(calls[0].folders.map((f) => f._id)).toEqual(['fa', 'fj', 'fs'])
    expect(calls[1]).toEqual({ reconcile: true, keepFolderIds: ['fa', 'fj', 'fs'] })
  })

  it('a delta flush with dirty folders re-sweeps folders (push + reconcile)', async () => {
    setupGame({ folders: [folder('f1'), folder('f2')] })
    const { WorldActorSnapshot } = await loadSnapshot()
    const calls = []
    const svc = new WorldActorSnapshot(fakeApi(calls))
    svc._running = true
    svc._foldersDirty = true
    await svc._flushDeltas()

    expect(calls[0].folders.map((f) => f._id)).toEqual(['f1', 'f2'])
    expect(calls[1]).toEqual({ reconcile: true, keepFolderIds: ['f1', 'f2'] })
    expect(svc._foldersDirty).toBe(false)
  })

  it('an UNELECTED reporter clears the folder-dirty flag without pushing', async () => {
    setupGame({ folders: [folder('f1')], userId: 'gm2', gms: ['gm1', 'gm2'] })
    const { WorldActorSnapshot } = await loadSnapshot()
    const calls = []
    const svc = new WorldActorSnapshot(fakeApi(calls))
    svc._running = true
    svc._foldersDirty = true
    await svc._flushDeltas()

    expect(calls).toEqual([])
    expect(svc._foldersDirty).toBe(false)
  })

  it('a folder-only delta does not push actors (no spurious actor reconcile)', async () => {
    setupGame({ actors: [actor('a')], folders: [folder('f1')] })
    const { WorldActorSnapshot } = await loadSnapshot()
    const actorCalls = []
    const svc = new WorldActorSnapshot({
      pushWorldActors: async (w, body) => { actorCalls.push(body); return {} },
      pushWorldFolders: async () => ({}),
    })
    svc._running = true
    svc._foldersDirty = true
    await svc._flushDeltas()

    expect(actorCalls).toEqual([]) // no dirty actors, no delete → actors untouched
  })
})
