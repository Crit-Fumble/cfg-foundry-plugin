/**
 * Character pull-sync (cfs#17 #147) — the Core→Foundry write-back loop. Covers
 * the single-reporter election, filtering to pending+core records, applying a
 * matched record to the live actor + pushing it back to close the loop, and
 * skipping records whose actor is missing or whose character has no foundry.actor.
 */

import { jest } from '@jest/globals'
import { CharacterPullSync } from '../../scripts/services/character-pull-sync.js'

// ── Test doubles ──────────────────────────────────────────────────────────────

/** Array of users that also exposes Foundry's `.filter`/`.map` (native) — no `.get` needed here. */
function users(list) {
  return [...list]
}

/** Minimal live actor with toObject (the GM-side serialization path). */
function actor(id, name = id) {
  return { id, name, system: { hp: 1 }, items: [], toObject: () => ({ _id: id, name, system: { hp: 1 }, items: [] }) }
}

/** game.actors.get backed by a Map of the actors that exist in this world. */
function actorsCollection(actorList) {
  const map = new Map(actorList.map((a) => [a.id, a]))
  return { get: (id) => map.get(id) ?? null }
}

function record(id, foundryActorId, characterId, { syncStatus = 'pending', lastSyncFrom = 'core' } = {}) {
  return { id, foundryActorId, syncStatus, lastSyncFrom, character: { id: characterId, name: characterId } }
}

function character(id, withFoundryActor = true) {
  return {
    id,
    name: id,
    characterSheetData: withFoundryActor
      ? { foundry: { actor: { name: id, type: 'character', system: { hp: 2 }, items: [] } } }
      : { abilities: {} },
  }
}

function api({ syncs = [], playerCharacters = [], npcCharacters = [] } = {}) {
  return {
    getSyncRecords: jest.fn(async () => ({ syncs })),
    getCampaignCharacters: jest.fn(async () => ({ playerCharacters, npcCharacters })),
    pushActorSync: jest.fn(async () => ({ synced: 1, conflict: 0, unmapped: 0, errors: 0, results: [] })),
    registerActorMapping: jest.fn(async () => ({ syncId: 'new', systemUpdate: {}, itemUpdates: [] })),
  }
}

/** A character whose canonical foundry.actor carries an explicit _id (the map key). */
function characterWithActorId(id, foundryActorId) {
  return {
    id,
    name: id,
    characterSheetData: { foundry: { actor: { _id: foundryActorId, name: id, type: 'character', system: {}, items: [] } } },
  }
}

function syncManager() {
  return { updateActorFromCharacter: jest.fn(async () => {}) }
}

const linked = (...ids) => () => ids

beforeEach(() => {
  game.user = { id: 'gm-a', isGM: true }
  game.users = users([{ id: 'gm-a', active: true, isGM: true }])
  game.actors = actorsCollection([])
})

// ── Election ──────────────────────────────────────────────────────────────────

describe('reporter election', () => {
  it('the elected GM (smallest human id) acts', async () => {
    game.users = users([
      { id: 'gm-a', active: true, isGM: true },
      { id: 'gm-b', active: true, isGM: true },
    ])
    game.user = { id: 'gm-a', isGM: true }
    game.actors = actorsCollection([actor('act-1')])
    const a = api({
      syncs: [record('s1', 'act-1', 'char-1')],
      playerCharacters: [{ character: character('char-1') }],
    })
    const sm = syncManager()

    await new CharacterPullSync(a, sm, linked('camp-1'))._tick()

    expect(a.getSyncRecords).toHaveBeenCalledWith('camp-1')
    expect(sm.updateActorFromCharacter).toHaveBeenCalledTimes(1)
  })

  it('a non-elected GM stays quiet (another GM has a smaller id)', async () => {
    game.users = users([
      { id: 'gm-a', active: true, isGM: true },
      { id: 'gm-b', active: true, isGM: true },
    ])
    game.user = { id: 'gm-b', isGM: true } // not the smallest
    const a = api({ syncs: [record('s1', 'act-1', 'char-1')] })

    await new CharacterPullSync(a, syncManager(), linked('camp-1'))._tick()

    expect(a.getSyncRecords).not.toHaveBeenCalled()
  })

  it('the service-GM defers to a present human GM', async () => {
    game.users = users([
      { id: 'gm-a', active: true, isGM: true }, // human GM
      { id: 'CFGServiceGM0000', active: true, isGM: true }, // service-GM
    ])
    game.user = { id: 'CFGServiceGM0000', isGM: true }
    const a = api({ syncs: [record('s1', 'act-1', 'char-1')] })

    await new CharacterPullSync(a, syncManager(), linked('camp-1'))._tick()

    expect(a.getSyncRecords).not.toHaveBeenCalled()
  })

  it('the lone service-GM acts when it is the only GM', async () => {
    game.users = users([{ id: 'CFGServiceGM0000', active: true, isGM: true }])
    game.user = { id: 'CFGServiceGM0000', isGM: true }
    game.actors = actorsCollection([actor('act-1')])
    const a = api({
      syncs: [record('s1', 'act-1', 'char-1')],
      playerCharacters: [{ character: character('char-1') }],
    })
    const sm = syncManager()

    await new CharacterPullSync(a, sm, linked('camp-1'))._tick()

    expect(sm.updateActorFromCharacter).toHaveBeenCalledTimes(1)
  })
})

// ── Filtering ───────────────────────────────────────────────────────────────────

describe('record filtering', () => {
  it('acts only on pending + lastSyncFrom:core records', async () => {
    game.actors = actorsCollection([actor('act-pending'), actor('act-synced'), actor('act-foundry')])
    const a = api({
      syncs: [
        record('s-pending', 'act-pending', 'char-pending'), // pending + core → apply
        record('s-synced', 'act-synced', 'char-synced', { syncStatus: 'synced' }), // skip
        record('s-foundry', 'act-foundry', 'char-foundry', { lastSyncFrom: 'foundry' }), // skip
      ],
      playerCharacters: [
        { character: character('char-pending') },
        { character: character('char-synced') },
        { character: character('char-foundry') },
      ],
    })
    const sm = syncManager()

    await new CharacterPullSync(a, sm, linked('camp-1'))._tick()

    expect(sm.updateActorFromCharacter).toHaveBeenCalledTimes(1)
    expect(sm.updateActorFromCharacter.mock.calls[0][1].id).toBe('char-pending')
  })

  it('does nothing when no campaigns are linked', async () => {
    const a = api({ syncs: [record('s1', 'act-1', 'char-1')] })
    await new CharacterPullSync(a, syncManager(), linked())._tick()
    expect(a.getSyncRecords).not.toHaveBeenCalled()
  })
})

// ── Apply + push-back (closing the loop) ─────────────────────────────────────────

describe('apply + push-back', () => {
  it('applies the character to the live actor then pushes the actor back to close the loop', async () => {
    const liveActor = actor('act-1', 'Aria')
    game.actors = actorsCollection([liveActor])
    const char = character('char-1')
    const a = api({
      syncs: [record('s1', 'act-1', 'char-1')],
      playerCharacters: [{ character: char }],
    })
    const sm = syncManager()

    await new CharacterPullSync(a, sm, linked('camp-1'))._tick()

    // Applied the character's foundry.actor to the live actor.
    expect(sm.updateActorFromCharacter).toHaveBeenCalledWith(liveActor, char)
    // Pushed the (toObject-serialized) actor back via the Foundry→Core endpoint.
    expect(a.pushActorSync).toHaveBeenCalledTimes(1)
    const [campaignId, actors] = a.pushActorSync.mock.calls[0]
    expect(campaignId).toBe('camp-1')
    expect(actors).toEqual([{ _id: 'act-1', name: 'Aria', system: { hp: 1 }, items: [] }])
  })

  it('serializes an actor that lacks toObject via the _id/name/system/items fallback', async () => {
    const liveActor = {
      id: 'act-1',
      name: 'Bob',
      system: { hp: 5 },
      items: [{ toObject: () => ({ _id: 'i1' }) }],
    }
    game.actors = actorsCollection([liveActor])
    const a = api({
      syncs: [record('s1', 'act-1', 'char-1')],
      playerCharacters: [{ character: character('char-1') }],
    })

    await new CharacterPullSync(a, syncManager(), linked('camp-1'))._tick()

    expect(a.pushActorSync.mock.calls[0][1]).toEqual([
      { _id: 'act-1', name: 'Bob', system: { hp: 5 }, items: [{ _id: 'i1' }] },
    ])
  })

  it('matches characters from npcCharacters too', async () => {
    game.actors = actorsCollection([actor('act-npc')])
    const a = api({
      syncs: [record('s-npc', 'act-npc', 'char-npc')],
      playerCharacters: [],
      npcCharacters: [character('char-npc')],
    })
    const sm = syncManager()

    await new CharacterPullSync(a, sm, linked('camp-1'))._tick()

    expect(sm.updateActorFromCharacter).toHaveBeenCalledTimes(1)
    expect(a.pushActorSync).toHaveBeenCalledTimes(1)
  })
})

// ── Skips ────────────────────────────────────────────────────────────────────────

describe('skips', () => {
  it('skips a record whose actor is not in game.actors', async () => {
    game.actors = actorsCollection([]) // actor missing
    const a = api({
      syncs: [record('s1', 'missing-actor', 'char-1')],
      playerCharacters: [{ character: character('char-1') }],
    })
    const sm = syncManager()

    await new CharacterPullSync(a, sm, linked('camp-1'))._tick()

    expect(sm.updateActorFromCharacter).not.toHaveBeenCalled()
    expect(a.pushActorSync).not.toHaveBeenCalled()
  })

  it('skips a record whose character has no foundry.actor', async () => {
    game.actors = actorsCollection([actor('act-1')])
    const a = api({
      syncs: [record('s1', 'act-1', 'char-1')],
      playerCharacters: [{ character: character('char-1', /* withFoundryActor */ false) }],
    })
    const sm = syncManager()

    await new CharacterPullSync(a, sm, linked('camp-1'))._tick()

    expect(sm.updateActorFromCharacter).not.toHaveBeenCalled()
    expect(a.pushActorSync).not.toHaveBeenCalled()
  })

  it('skips a record whose character is not in the campaign fetch', async () => {
    game.actors = actorsCollection([actor('act-1')])
    const a = api({
      syncs: [record('s1', 'act-1', 'char-missing')],
      playerCharacters: [{ character: character('char-other') }],
    })
    const sm = syncManager()

    await new CharacterPullSync(a, sm, linked('camp-1'))._tick()

    expect(sm.updateActorFromCharacter).not.toHaveBeenCalled()
  })

  it('one failing record does not stop the others', async () => {
    game.actors = actorsCollection([actor('act-1'), actor('act-2')])
    const a = api({
      syncs: [record('s1', 'act-1', 'char-1'), record('s2', 'act-2', 'char-2')],
      playerCharacters: [{ character: character('char-1') }, { character: character('char-2') }],
    })
    const sm = syncManager()
    sm.updateActorFromCharacter.mockImplementationOnce(async () => {
      throw new Error('boom')
    })

    await new CharacterPullSync(a, sm, linked('camp-1'))._tick()

    // char-1 threw; char-2 still applied + pushed.
    expect(sm.updateActorFromCharacter).toHaveBeenCalledTimes(2)
    expect(a.pushActorSync).toHaveBeenCalledTimes(1)
  })

  it('is non-fatal when getSyncRecords throws', async () => {
    const a = api({})
    a.getSyncRecords.mockRejectedValue(new Error('network'))
    await expect(new CharacterPullSync(a, syncManager(), linked('camp-1'))._tick()).resolves.toBeUndefined()
  })

  it('does not overlap a busy tick', async () => {
    const a = api({ syncs: [] })
    const pull = new CharacterPullSync(a, syncManager(), linked('camp-1'))
    pull._busy = true
    await pull._tick()
    expect(a.getSyncRecords).not.toHaveBeenCalled()
  })
})

// ── Bootstrap registration (the mapping the whole loop depends on) ─────────────────

describe('mapping bootstrap', () => {
  it('registers a mapping for an unrecorded character whose foundry.actor is live in this world', async () => {
    game.actors = actorsCollection([actor('act-42')])
    const a = api({
      syncs: [], // no record yet
      playerCharacters: [{ character: characterWithActorId('char-1', 'act-42') }],
    })

    await new CharacterPullSync(a, syncManager(), linked('camp-1'))._tick()

    expect(a.registerActorMapping).toHaveBeenCalledWith('camp-1', 'char-1', 'act-42')
  })

  it('does NOT re-register a character that already has a record (would reset synced→pending)', async () => {
    game.actors = actorsCollection([actor('act-42')])
    const a = api({
      syncs: [record('s1', 'act-42', 'char-1', { syncStatus: 'synced', lastSyncFrom: 'foundry' })],
      playerCharacters: [{ character: characterWithActorId('char-1', 'act-42') }],
    })

    await new CharacterPullSync(a, syncManager(), linked('camp-1'))._tick()

    expect(a.registerActorMapping).not.toHaveBeenCalled()
  })

  it('does NOT register when the character actor is not present in this world', async () => {
    game.actors = actorsCollection([]) // actor not live here
    const a = api({
      syncs: [],
      playerCharacters: [{ character: characterWithActorId('char-1', 'act-42') }],
    })

    await new CharacterPullSync(a, syncManager(), linked('camp-1'))._tick()

    expect(a.registerActorMapping).not.toHaveBeenCalled()
  })

  it('registration failure is non-fatal (retries next tick)', async () => {
    game.actors = actorsCollection([actor('act-42')])
    const a = api({ syncs: [], playerCharacters: [{ character: characterWithActorId('char-1', 'act-42') }] })
    a.registerActorMapping.mockRejectedValue(new Error('403'))

    await expect(new CharacterPullSync(a, syncManager(), linked('camp-1'))._tick()).resolves.toBeUndefined()
  })
})
