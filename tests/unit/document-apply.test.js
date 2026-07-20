/**
 * Shared document-apply core (dt#185 + dt#212 parity).
 *
 * `withDeletions` and `applyDesiredDocument` are the ONE authority for how a desired document state
 * reaches Foundry — used by both the compendium write-back and the in-Foundry JSON editor. A second
 * copy that drifted on the deletion markers or the type-change handling would be a silent data-loss
 * bug, which is why they live here and are tested here rather than duplicated per caller.
 */

import { jest } from '@jest/globals'

async function load() {
  jest.resetModules()
  return await import('../../scripts/services/document-apply.js')
}

const withDeletions = async (...args) => (await load()).withDeletions(...args)

describe('withDeletions', () => {
  it('marks a key the desired state dropped', async () => {
    expect(await withDeletions({ a: 1, b: 2 }, { a: 1 })).toEqual({ a: 1, '-=b': null })
  })

  it('recurses into nested objects — the advancement case', async () => {
    // The live failure: an advancement collection keyed by _id, with one member removed.
    const live = { system: { advancement: { keep1: { type: 'Trait' }, hp1: { type: 'HitPoints' } } } }
    const next = { system: { advancement: { keep1: { type: 'Trait' } } } }
    expect(await withDeletions(live, next)).toEqual({
      system: { advancement: { keep1: { type: 'Trait' }, '-=hp1': null } },
    })
  })

  it('never deletes _id or type — identity, not content', async () => {
    // `type` matters most: the caller strips it from the payload, so a naive diff concludes the GM
    // removed it and emits `-=type`, asking Foundry to delete the field that decides what it IS.
    expect(await withDeletions({ _id: 'abc', type: 'subclass', a: 1 }, { a: 1 })).toEqual({ a: 1 })
  })

  it('does not descend into arrays', async () => {
    // update() replaces arrays wholesale, so index deletions would be meaningless noise.
    expect(await withDeletions({ tags: ['x', 'y', 'z'] }, { tags: ['x'] })).toEqual({ tags: ['x'] })
  })

  it('adds nothing when the desired state only adds', async () => {
    expect(await withDeletions({ a: 1 }, { a: 1, b: 2 })).toEqual({ a: 1, b: 2 })
  })

  it('replaces rather than recurses when the shape changes', async () => {
    expect(await withDeletions({ v: { nested: 1 } }, { v: 'now a string' })).toEqual({ v: 'now a string' })
    expect(await withDeletions({ v: 'was a string' }, { v: { nested: 1 } })).toEqual({ v: { nested: 1 } })
  })
})

/** A live Foundry document stub recording what was done to it. */
function liveDoc(type, data = { type }) {
  return { type, toObject: () => data, update: jest.fn(async () => true), delete: jest.fn(async () => true) }
}

/** A DocClass whose instances carry a throwing advancement only when `data.name === 'Broken'`. */
function makeDocClass() {
  const create = jest.fn(async (data, opts) => ({ _id: data._id, type: data.type, __opts: opts }))
  const DocClass = class {
    static create = create
    constructor(data) {
      this.type = data.type
      this.advancement =
        data.name === 'Broken'
          ? { byId: { a: { constructor: { name: 'HitPointsAdvancement' }, sortingValueForLevel: () => { throw new Error('boom') } } } }
          : undefined
    }
  }
  return DocClass
}

beforeEach(() => {
  globalThis.foundry = { utils: { deepClone: (v) => JSON.parse(JSON.stringify(v)) } }
})

describe('applyDesiredDocument', () => {
  it('delete + recreate with keepId on a type change', async () => {
    const { applyDesiredDocument } = await load()
    const DocClass = makeDocClass()
    const live = liveDoc('class')
    await applyDesiredDocument(live, DocClass, { _id: 'abc', type: 'subclass', name: 'Ok' }, { collection: 'world.p' })
    expect(live.delete).toHaveBeenCalled()
    expect(DocClass.create).toHaveBeenCalledWith(
      { _id: 'abc', type: 'subclass', name: 'Ok' },
      { pack: 'world.p', keepId: true },
    )
  })

  it('update with deletion markers on the same type', async () => {
    const { applyDesiredDocument } = await load()
    const DocClass = makeDocClass()
    const live = liveDoc('feat', { type: 'feat', name: 'Old', extra: 1 })
    await applyDesiredDocument(live, DocClass, { _id: 'abc', type: 'feat', name: 'New' })
    expect(live.delete).not.toHaveBeenCalled()
    expect(DocClass.create).not.toHaveBeenCalled()
    // type stripped; `extra` removed via marker.
    expect(live.update).toHaveBeenCalledWith({ name: 'New', '-=extra': null })
  })

  it('keepId WITHOUT a pack for a world document', async () => {
    const { applyDesiredDocument } = await load()
    const DocClass = makeDocClass()
    const live = liveDoc('class')
    await applyDesiredDocument(live, DocClass, { _id: 'abc', type: 'subclass', name: 'Ok' })
    expect(DocClass.create).toHaveBeenCalledWith(expect.any(Object), { keepId: true })
  })

  it('refuses a doomed document and touches NOTHING', async () => {
    const { applyDesiredDocument, DocumentHealthError } = await load()
    const DocClass = makeDocClass()
    const live = liveDoc('class')
    await expect(
      applyDesiredDocument(live, DocClass, { _id: 'abc', type: 'subclass', name: 'Broken' }),
    ).rejects.toBeInstanceOf(DocumentHealthError)
    expect(live.delete).not.toHaveBeenCalled()
    expect(live.update).not.toHaveBeenCalled()
    expect(DocClass.create).not.toHaveBeenCalled()
  })
})
