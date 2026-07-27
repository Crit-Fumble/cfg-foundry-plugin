/**
 * Module-pack import sync (dt#185) — the plugin leg of the import queue.
 *
 * Pins the load-bearing behaviour:
 *   - a pending request is fulfilled by reading `game.packs.get('<pkg>.<pack>')` and pushing
 *     the documents, batched, with `done: true` only on the final batch;
 *   - folders ride the FIRST batch only;
 *   - a pack this world does not have parks the request with an `error` push instead of
 *     retrying forever;
 *   - only the elected reporter does any work.
 */

import { jest } from '@jest/globals'

async function loadSync() {
  jest.resetModules()
  return await import('../../scripts/services/module-pack-import-sync.js')
}

function apiStub(plan) {
  return {
    getModulePackImportPlan: jest.fn(async () => ({ data: plan })),
    pushModulePackImport: jest.fn(async (_inst, body) => ({ data: { applied: body.entries.length, status: body.done ? 'synced' : 'pending' } })),
  }
}

function packDoc(id, name) {
  return {
    id,
    name,
    toObject: () => ({ _id: id, name, type: 'class', sort: 0, folder: null, system: { levels: 20 } }),
  }
}

beforeEach(() => {
  game.world = { id: 'test-world' }
  game.user = { id: 'gm1', isGM: true }
  game.users = { filter: (fn) => [{ id: 'gm1', active: true, isGM: true }].filter(fn) }
})

it('fulfils a pending request: reads the pack, pushes docs batched with done on the last', async () => {
  const docs = Array.from({ length: 250 }, (_, i) => packDoc(`Item${String(i).padStart(12, '0')}`, `Doc ${i}`))
  game.packs = {
    get: jest.fn((id) =>
      id === 'dnd5e.classes24'
        ? {
            getDocuments: async () => docs,
            folders: { contents: [{ id: 'F1', name: 'Martial', color: null, sort: 0, folder: null }] },
          }
        : undefined,
    ),
  }
  const api = apiStub([{ requestId: 'req1', packageId: 'dnd5e', packName: 'classes24' }])

  const { ModulePackImportSync } = await loadSync()
  const sync = new ModulePackImportSync(api, 'inst1')
  sync._running = true // start() also arms a real interval — drive the tick directly instead
  await sync._tick()

  // 250 docs at batch size 200 → two pushes.
  expect(api.pushModulePackImport).toHaveBeenCalledTimes(2)
  const [inst1, first] = api.pushModulePackImport.mock.calls[0]
  const [, second] = api.pushModulePackImport.mock.calls[1]
  expect(inst1).toBe('inst1')
  expect(first.requestId).toBe('req1')
  expect(first.entries).toHaveLength(200)
  expect(first.done).toBe(false)
  // Folders ride the first batch only.
  expect(first.folders).toEqual([{ _id: 'F1', name: 'Martial', color: null, sort: 0, folder: null }])
  expect(second.folders).toBeUndefined()
  expect(second.entries).toHaveLength(50)
  expect(second.done).toBe(true)
  // The wire entry carries the verbatim doc.
  expect(first.entries[0].doc.system.levels).toBe(20)
})

it('parks a request whose pack is not in this world with an error push', async () => {
  game.packs = { get: jest.fn(() => undefined) }
  const api = apiStub([{ requestId: 'req2', packageId: 'gone-module', packName: 'gone-pack' }])

  const { ModulePackImportSync } = await loadSync()
  const sync = new ModulePackImportSync(api, 'inst1')
  sync._running = true // start() also arms a real interval — drive the tick directly instead
  await sync._tick()

  expect(api.pushModulePackImport).toHaveBeenCalledTimes(1)
  const [, body] = api.pushModulePackImport.mock.calls[0]
  expect(body.error).toContain('gone-module.gone-pack')
  expect(body.done).toBe(false)
  expect(body.entries).toEqual([])
})

it('does nothing when this client is not the elected reporter', async () => {
  game.users = {
    filter: (fn) =>
      [
        { id: 'aaa-gm', active: true, isGM: true }, // smaller id → elected
        { id: 'gm1', active: true, isGM: true },
      ].filter(fn),
  }
  const api = apiStub([{ requestId: 'req3', packageId: 'dnd5e', packName: 'classes24' }])

  const { ModulePackImportSync } = await loadSync()
  const sync = new ModulePackImportSync(api, 'inst1')
  sync._running = true // start() also arms a real interval — drive the tick directly instead
  await sync._tick()

  expect(api.getModulePackImportPlan).not.toHaveBeenCalled()
  expect(api.pushModulePackImport).not.toHaveBeenCalled()
})

it('one failing request does not strand the rest of the queue', async () => {
  game.packs = {
    get: jest.fn((id) =>
      id === 'dnd5e.ok-pack'
        ? { getDocuments: async () => [packDoc('Item000000000001', 'OK Doc')], folders: { contents: [] } }
        : undefined,
    ),
  }
  const api = apiStub([
    { requestId: 'bad', packageId: 'gone', packName: 'gone' },
    { requestId: 'good', packageId: 'dnd5e', packName: 'ok-pack' },
  ])
  // The error push for the bad request itself blows up — the good one must still run.
  api.pushModulePackImport.mockImplementationOnce(async () => {
    throw new Error('server said no')
  })

  const { ModulePackImportSync } = await loadSync()
  const sync = new ModulePackImportSync(api, 'inst1')
  sync._running = true // start() also arms a real interval — drive the tick directly instead
  await sync._tick()

  const goodCall = api.pushModulePackImport.mock.calls.find(([, b]) => b.requestId === 'good')
  expect(goodCall).toBeDefined()
  expect(goodCall[1].done).toBe(true)
})
