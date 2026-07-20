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

describe('_applyEntry — document health guard (dt#213)', () => {
  it('refuses a doc that would crash Foundry, WITHOUT deleting the live document', async () => {
    // The corruption this prevents: the type-change path is delete + recreate, so a recreate that
    // crashes on prep would leave the world with the document deleted and nothing in its place.
    // Probing up front means nothing destructive runs on a doomed doc. Verified against real
    // dnd5e in specs/document-health-probe.spec.js; here the crash is modelled with a throwing
    // advancement so the guard's WIRING is pinned without a Foundry.
    globalThis.foundry = { utils: { deepClone: (v) => JSON.parse(JSON.stringify(v)) } }
    class CrashingDoc {
      static create = jest.fn(async () => ({ _id: 'x' }))
      constructor(data) {
        this.type = data.type
        this.advancement = {
          byId: {
            a: {
              constructor: { name: 'HitPointsAdvancement' },
              sortingValueForLevel: () => {
                throw new Error("Cannot read properties of undefined (reading 'denomination')")
              },
            },
          },
        }
      }
    }
    globalThis.CONFIG = { Item: { documentClass: CrashingDoc } }

    const { CompendiumPullSync } = await loadSync()
    const svc = new CompendiumPullSync({})
    const live = liveDoc('class')
    const pack = packStub(live)

    await expect(
      svc._applyEntry(pack, { foundryEntryId: 'abc123', doc: { type: 'subclass', name: 'Broken' } }),
    ).rejects.toThrow(/fails to prepare/)

    expect(live.delete).not.toHaveBeenCalled()
    expect(CrashingDoc.create).not.toHaveBeenCalled()
    expect(live.update).not.toHaveBeenCalled()
  })

  it('reports a health failure at warn and keeps applying the rest of the pack', async () => {
    // A doomed entry must not strand the queue. _applyPack catches DocumentHealthError, warns, and
    // moves on — the bad entry stays pending (not reported applied), a good sibling still lands.
    globalThis.foundry = { utils: { deepClone: (v) => JSON.parse(JSON.stringify(v)) } }
    class MaybeCrashingDoc {
      static create = jest.fn(async (data) => ({ _id: data._id, type: data.type }))
      constructor(data) {
        this.type = data.type
        // Only the entry named "Broken" carries a throwing advancement.
        this.advancement =
          data.name === 'Broken'
            ? { byId: { a: { constructor: { name: 'HitPointsAdvancement' }, valueForLevel: () => { throw new Error('boom') } } } }
            : undefined
      }
    }
    globalThis.CONFIG = { Item: { documentClass: MaybeCrashingDoc } }
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})

    const { CompendiumPullSync } = await loadSync()
    const svc = new CompendiumPullSync({})
    // Both entries absent from the world → the create path, so a healthy one lands via create.
    const pack = { collection: 'world.p', metadata: { type: 'Item', packageType: 'world' }, getDocument: jest.fn(async () => null) }
    globalThis.game.packs = { get: jest.fn(() => pack) }

    const applied = await svc._applyPack({
      name: 'p',
      entries: [
        { foundryEntryId: 'bad1', doc: { type: 'subclass', name: 'Broken' } },
        { foundryEntryId: 'good1', doc: { type: 'feat', name: 'Fine' } },
      ],
    })

    expect(applied).toEqual(['good1'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('would crash Foundry'), expect.any(String))
    warn.mockRestore()
  })
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
