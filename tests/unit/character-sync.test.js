/**
 * CharacterSyncManager — Foundry-shape pass-through (cfs#17 #147).
 *
 * The platform sheet IS a Foundry actor (characterSheetData.foundry.actor), so
 * mapCharacterToActorData passes its `system` + items through verbatim instead
 * of the legacy per-system (dnd5e) mapping.
 */

import { jest } from '@jest/globals'

let CharacterSyncManager

beforeAll(async () => {
  ;({ CharacterSyncManager } = await import('../../scripts/services/character-sync.js'))
})

describe('mapCharacterToActorData', () => {
  const mgr = () => new CharacterSyncManager({}, null)

  it('passes the stored foundry.actor system + items through verbatim', async () => {
    const character = {
      name: 'Aria',
      characterSheetData: {
        foundry: {
          systemId: 'dnd5e',
          actor: {
            name: 'Aria',
            type: 'character',
            system: { attributes: { hp: { value: 18, max: 24 } }, abilities: { str: { value: 14 } } },
            items: [{ _id: 'i1', name: 'Longsword', type: 'weapon', system: {} }],
          },
        },
      },
    }
    const data = await mgr().mapCharacterToActorData(character)
    expect(data.type).toBe('character')
    expect(data.system).toEqual({ attributes: { hp: { value: 18, max: 24 } }, abilities: { str: { value: 14 } } })
    expect(data.items).toHaveLength(1)
    expect(data.items[0].name).toBe('Longsword')
  })

  it('reads the nested sheetData shape too (list GET / pull-loop)', async () => {
    const character = {
      name: 'Aria',
      sheetData: {
        characterSheetData: {
          foundry: { actor: { name: 'Aria', type: 'character', system: { attributes: { hp: { value: 7, max: 12 } } } } },
        },
      },
    }
    const data = await mgr().mapCharacterToActorData(character)
    expect(data.system.attributes.hp.value).toBe(7)
    expect(data.type).toBe('character')
  })

  it('defaults name/type/items when the stored actor omits them', async () => {
    const character = { name: 'Bob', characterSheetData: { foundry: { actor: { system: { pools: {} } } } } }
    const data = await mgr().mapCharacterToActorData(character)
    expect(data.name).toBe('Bob')
    expect(data.type).toBe('character')
    expect(data.items).toEqual([])
  })

  it('falls back to the legacy mapper when there is no foundry.actor', async () => {
    const m = mgr()
    const spy = jest
      .spyOn(m, '_mapLegacyCharacterToActorData')
      .mockResolvedValue({ name: 'Legacy', type: 'character', system: {} })
    const data = await m.mapCharacterToActorData({ name: 'Legacy', characterSheetData: { abilities: {} } })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(data.name).toBe('Legacy')
    spy.mockRestore()
  })
})

/** A live Foundry Actor mock: records update/embedded-doc calls; items is a Collection-like. */
function makeActorMock(liveItems = []) {
  const items = liveItems.map((i) => ({
    id: i._id,
    _id: i._id,
    getFlag: (scope, key) => i.flags?.[scope]?.[key],
  }))
  return {
    id: 'actor-1',
    name: 'Live Actor',
    items: {
      get: (id) => items.find((i) => i._id === id) || null,
      filter: (fn) => items.filter(fn),
      map: (fn) => items.map(fn),
    },
    update: jest.fn(async () => {}),
    createEmbeddedDocuments: jest.fn(async () => {}),
    updateEmbeddedDocuments: jest.fn(async () => {}),
    deleteEmbeddedDocuments: jest.fn(async () => {}),
  }
}

describe('updateActorFromCharacter — Bug B regression (cfs#17 #147)', () => {
  const mgr = () => new CharacterSyncManager({}, null)

  it('applies the NESTED list-GET sheet shape without throwing (the write-back pull-loop feed)', async () => {
    const character = {
      id: 'char-1',
      name: 'Aria',
      // The list GET nests the sheet under sheetData — the old code destructured
      // top-level characterSheetData and threw here, stranding the record pending.
      sheetData: {
        characterSheetData: {
          foundry: { actor: { name: 'Aria', type: 'character', system: { attributes: { hp: { value: 4, max: 10 } } }, items: [] } },
        },
      },
    }
    const actor = makeActorMock()
    const m = mgr()
    const validateSpy = jest.spyOn(m, 'validateCharacter')

    await expect(m.updateActorFromCharacter(actor, character)).resolves.toBeUndefined()

    // System (HP) is written…
    expect(actor.update).toHaveBeenCalledTimes(1)
    const patch = actor.update.mock.calls[0][0]
    expect(patch.system.attributes.hp.value).toBe(4)
    // …`type` is NOT patched (immutable on an existing actor)…
    expect(patch).not.toHaveProperty('type')
    // …and the canonical foundry.actor sheet skips server-side validation.
    expect(validateSpy).not.toHaveBeenCalled()
    validateSpy.mockRestore()
  })

  it('still throws when the character genuinely has no sheet data', async () => {
    await expect(mgr().updateActorFromCharacter(makeActorMock(), { id: 'x', name: 'x' })).rejects.toThrow('no sheet data')
  })
})

describe('_applyFoundryActorItems — item write-back reconciliation', () => {
  const mgr = () => new CharacterSyncManager({}, null)

  it('creates missing (keepId), updates existing by _id, deletes dropped synced items, spares GM items', async () => {
    const actor = makeActorMock([
      { _id: 'keep', flags: { 'crit-fumble-core': { isSyncedItem: true } } }, // synced + still present → update
      { _id: 'gone', flags: { 'crit-fumble-core': { isSyncedItem: true } } }, // synced + dropped → delete
      { _id: 'gm-made', flags: {} }, // GM-authored, unflagged → never touched
    ])
    const stored = [
      { _id: 'keep', name: 'Longsword', type: 'weapon', system: {} },
      { _id: 'new', name: 'Shield', type: 'equipment', system: {} },
    ]
    await mgr()._applyFoundryActorItems(actor, stored)

    // 'new' created with keepId so future syncs match by _id.
    expect(actor.createEmbeddedDocuments).toHaveBeenCalledTimes(1)
    const [, createdDocs, createOpts] = actor.createEmbeddedDocuments.mock.calls[0]
    expect(createdDocs.map((d) => d._id)).toEqual(['new'])
    expect(createOpts).toMatchObject({ keepId: true })
    expect(createdDocs[0].flags['crit-fumble-core'].isSyncedItem).toBe(true)

    // 'keep' updated by _id.
    expect(actor.updateEmbeddedDocuments).toHaveBeenCalledTimes(1)
    expect(actor.updateEmbeddedDocuments.mock.calls[0][1].map((d) => d._id)).toEqual(['keep'])

    // 'gone' deleted; 'gm-made' (unflagged) spared.
    expect(actor.deleteEmbeddedDocuments).toHaveBeenCalledTimes(1)
    expect(actor.deleteEmbeddedDocuments.mock.calls[0][1]).toEqual(['gone'])
  })

  it('no-ops cleanly on an empty item set', async () => {
    const actor = makeActorMock()
    await mgr()._applyFoundryActorItems(actor, [])
    expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled()
    expect(actor.updateEmbeddedDocuments).not.toHaveBeenCalled()
    expect(actor.deleteEmbeddedDocuments).not.toHaveBeenCalled()
  })
})
