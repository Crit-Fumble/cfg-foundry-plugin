/**
 * Compendium write-back apply paths (dt#185 slice 3).
 *
 * There was NO test file for this service, which is how the type-change path stayed dead code:
 * it was gated on a server flag that can never be true, so retooling a class into a subclass
 * updated on the platform and silently stayed a class in the world — the exact failure the flag
 * was introduced to prevent.
 *
 * `_applyEntry` is tested directly. It is where the update-vs-recreate decision lives, and that
 * decision is the whole point of the service.
 */

import { jest } from '@jest/globals'

async function loadSync() {
  jest.resetModules()
  return await import('../../scripts/services/compendium-pull-sync.js')
}

/** A live Foundry document stub that records what was done to it. */
function liveDoc(type) {
  return { type, update: jest.fn(async () => true), delete: jest.fn(async () => true) }
}

function packStub(live) {
  return {
    collection: 'world.character-classes',
    metadata: { type: 'Item' },
    getDocument: jest.fn(async () => live),
  }
}

let created

beforeEach(() => {
  jest.clearAllMocks()
  created = []
  globalThis.game = { world: { id: 'dead-space-cfg-x' }, user: { isGM: true, id: 'gm1' } }
  globalThis.CONFIG = {
    Item: {
      documentClass: {
        create: jest.fn(async (data, opts) => {
          created.push({ data, opts })
          return { _id: data._id, type: data.type }
        }),
      },
    },
  }
})

describe('_applyEntry', () => {
  it('recreates with keepId when the type changes — even though the server flag says otherwise', async () => {
    // The regression. `typeChanged` is derived from the held doc rather than the live document, so
    // it is always false; the live type is the only trustworthy comparison and the client has it.
    const { CompendiumPullSync } = await loadSync()
    const svc = new CompendiumPullSync({})
    const live = liveDoc('class')
    const pack = packStub(live)

    const ok = await svc._applyEntry(pack, {
      foundryEntryId: 'abc123',
      typeChanged: false,
      doc: { type: 'subclass', name: 'Expert', system: { classIdentifier: 'company-commander' } },
    })

    expect(ok).toBe(true)
    expect(live.delete).toHaveBeenCalled()
    expect(live.update).not.toHaveBeenCalled()
    expect(created).toHaveLength(1)
    expect(created[0].data._id).toBe('abc123')
    expect(created[0].data.type).toBe('subclass')
    expect(created[0].opts).toMatchObject({ keepId: true, pack: 'world.character-classes' })
  })

  it('takes the cheap update path when the type is unchanged', async () => {
    const { CompendiumPullSync } = await loadSync()
    const svc = new CompendiumPullSync({})
    const live = liveDoc('class')
    const pack = packStub(live)

    await svc._applyEntry(pack, { foundryEntryId: 'abc123', typeChanged: false, doc: { type: 'class', name: 'Expert' } })

    expect(live.delete).not.toHaveBeenCalled()
    expect(created).toHaveLength(0)
    // `type` is stripped rather than sent-and-ignored, so the no-op is explicit here.
    expect(live.update).toHaveBeenCalledWith({ name: 'Expert' })
  })

  it('recreates a document that is absent from the world', async () => {
    const { CompendiumPullSync } = await loadSync()
    const svc = new CompendiumPullSync({})
    const pack = packStub(null)

    const ok = await svc._applyEntry(pack, { foundryEntryId: 'gone1', doc: { type: 'feat', name: 'Expertise' } })

    expect(ok).toBe(true)
    expect(created[0].opts).toMatchObject({ keepId: true })
  })

  it('does not recreate when the doc carries no type at all', async () => {
    // A doc with no `type` is not a type change; deleting on that basis would destroy a document
    // over missing metadata.
    const { CompendiumPullSync } = await loadSync()
    const svc = new CompendiumPullSync({})
    const live = liveDoc('class')
    const pack = packStub(live)

    await svc._applyEntry(pack, { foundryEntryId: 'abc123', doc: { name: 'Expert' } })

    expect(live.delete).not.toHaveBeenCalled()
    expect(live.update).toHaveBeenCalled()
  })
})
