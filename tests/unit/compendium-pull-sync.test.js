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

describe('withDeletions', () => {
  it('marks a key the desired state dropped', async () => {
    const { withDeletions } = await loadSync()
    expect(withDeletions({ a: 1, b: 2 }, { a: 1 })).toEqual({ a: 1, '-=b': null })
  })

  it('recurses into nested objects — the advancement case', async () => {
    // The live failure: an advancement collection keyed by _id, with one member removed.
    const { withDeletions } = await loadSync()
    const live = { system: { advancement: { keep1: { type: 'Trait' }, hp1: { type: 'HitPoints' } } } }
    const next = { system: { advancement: { keep1: { type: 'Trait' } } } }
    expect(withDeletions(live, next)).toEqual({
      system: { advancement: { keep1: { type: 'Trait' }, '-=hp1': null } },
    })
  })

  it('never deletes _id or type — identity, not content', async () => {
    // `type` matters most: the caller strips it from the payload on purpose, so a naive diff
    // concludes the GM removed it and emits `-=type`, asking Foundry to delete the field that
    // decides what the document IS.
    const { withDeletions } = await loadSync()
    expect(withDeletions({ _id: 'abc', type: 'subclass', a: 1 }, { a: 1 })).toEqual({ a: 1 })
  })

  it('does not descend into arrays', async () => {
    // update() replaces arrays wholesale, so index deletions would be meaningless noise.
    const { withDeletions } = await loadSync()
    expect(withDeletions({ tags: ['x', 'y', 'z'] }, { tags: ['x'] })).toEqual({ tags: ['x'] })
  })

  it('adds nothing when the desired state only adds', async () => {
    const { withDeletions } = await loadSync()
    expect(withDeletions({ a: 1 }, { a: 1, b: 2 })).toEqual({ a: 1, b: 2 })
  })

  it('replaces rather than recurses when the shape changes', async () => {
    const { withDeletions } = await loadSync()
    expect(withDeletions({ v: { nested: 1 } }, { v: 'now a string' })).toEqual({ v: 'now a string' })
    expect(withDeletions({ v: 'was a string' }, { v: { nested: 1 } })).toEqual({ v: { nested: 1 } })
  })
})

/** A live Foundry document stub that records what was done to it. */
function liveDoc(type) {
  return {
    type,
    // Deletion markers are diffed against the live document's own data.
    toObject: () => ({ type }),
    update: jest.fn(async () => true),
    delete: jest.fn(async () => true),
  }
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

  it('propagates a REMOVAL through the update path', async () => {
    // Without the deletion markers this update merges and the advancement survives — which is
    // exactly what happened live, leaving a subclass whose sheet crashed on render.
    const { CompendiumPullSync } = await loadSync()
    const svc = new CompendiumPullSync({})
    const live = liveDoc('subclass')
    live.toObject = () => ({
      type: 'subclass',
      name: 'Expert',
      system: { advancement: { keep1: { type: 'Trait' }, hp1: { type: 'HitPoints' } } },
    })
    const pack = packStub(live)

    await svc._applyEntry(pack, {
      foundryEntryId: 'abc123',
      doc: { type: 'subclass', name: 'Expert', system: { advancement: { keep1: { type: 'Trait' } } } },
    })

    expect(live.update).toHaveBeenCalledWith({
      name: 'Expert',
      system: { advancement: { keep1: { type: 'Trait' }, '-=hp1': null } },
    })
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
