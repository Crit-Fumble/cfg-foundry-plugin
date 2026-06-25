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
