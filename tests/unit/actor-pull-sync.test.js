/**
 * Actor pull-sync (fp#46) — the GM-side half that carries a platform character into the
 * LIVE world, INCLUDING creating it.
 *
 * This replaces CharacterPullSync, whose two bail gates are what fp#46 was about:
 *   - `if (!game.actors.get(foundryActorId)) continue`  (no mapping ever registered)
 *   - `if (!actor) return // actor not in this world (yet)`
 * That `(yet)` never arrived: nothing in the plugin ever called `Actor.create`, so a
 * PlayTable-created character was invisible at the table forever. The two tests those
 * gates used to be pinned by are inverted here — absent + never-pushed now CREATES.
 *
 * The keepId assertion is load-bearing. Foundry's default is `keepId: false` and
 * `common/abstract/document.mjs:483` does `if (!keepId) delete data._id` — so without it
 * the server-assigned id is dropped, the create-if-absent lookup never matches, and we
 * duplicate every actor in the world every 30s, forever.
 */

import { jest } from '@jest/globals'
import { ActorPullSync } from '../../scripts/services/actor-pull-sync.js'

/** Array-backed game.users collection that also exposes Foundry's `.get(id)`. */
function makeUsers(list) {
  const arr = [...list]
  arr.get = (id) => arr.find((u) => u.id === id)
  return arr
}

const ACTOR_ID = 'DerivedActor0001'

const planItem = (over = {}) => ({
  characterId: 'char_1',
  foundryActorId: ACTOR_ID,
  everPushed: false,
  systemId: 'dnd5e',
  claimedAt: null,
  docData: {
    _id: ACTOR_ID,
    name: 'Aria Brightwood',
    type: 'character',
    system: { attributes: { hp: { value: 10, max: 10 } } },
    items: [{ _id: 'itemAAAAAAAAAAAA', name: 'Dagger', type: 'weapon' }],
    ownership: { default: 0, natAlice: 3 },
  },
  ...over,
})

function api(plan = []) {
  return {
    getActorSyncPlan: jest.fn(async () => ({ data: plan })),
    ackActorSync: jest.fn(async () => ({ data: { recorded: plan.length } })),
  }
}

/** A live Actor with the given embedded item/effect ids. */
function liveActor({ type = 'character', itemIds = [], effectIds = [] } = {}) {
  return {
    id: ACTOR_ID,
    type,
    toObject: () => ({ _id: ACTOR_ID, name: 'Stale', type, system: {}, items: [], effects: [] }),
    items: itemIds.map((id) => ({ id })),
    effects: effectIds.map((id) => ({ id })),
    update: jest.fn(async () => {}),
    delete: jest.fn(async () => {}),
    deleteEmbeddedDocuments: jest.fn(async () => {}),
    updateEmbeddedDocuments: jest.fn(async () => {}),
    createEmbeddedDocuments: jest.fn(async () => {}),
  }
}

function seedActors(byId = {}) {
  globalThis.game.actors = { get: (id) => byId[id] ?? undefined }
}

beforeEach(() => {
  globalThis.Actor = { create: jest.fn(async (d) => ({ id: d._id })) }
  globalThis.CONFIG = { Actor: { documentClass: function ActorClass() {} } }
  globalThis.foundry = { utils: { deepClone: (v) => JSON.parse(JSON.stringify(v)) } }
  globalThis.game = {
    world: { id: 'world-folder' },
    system: { id: 'dnd5e' },
    user: { id: 'gm-a', isGM: true },
    users: makeUsers([{ id: 'gm-a', active: true, isGM: true }]),
  }
  seedActors({})
})

describe('ActorPullSync — reporter election', () => {
  it('acts when this client is the elected (smallest-id human) GM', async () => {
    globalThis.game.users = makeUsers([
      { id: 'gm-a', active: true, isGM: true },
      { id: 'gm-b', active: true, isGM: true },
    ])
    const a = api([planItem()])
    await new ActorPullSync(a, 'inst-1').tick()
    expect(a.getActorSyncPlan).toHaveBeenCalled()
  })

  it('stays quiet on a non-elected GM client', async () => {
    globalThis.game.user = { id: 'gm-b', isGM: true }
    globalThis.game.users = makeUsers([
      { id: 'gm-a', active: true, isGM: true },
      { id: 'gm-b', active: true, isGM: true },
    ])
    const a = api([planItem()])
    await new ActorPullSync(a, 'inst-1').tick()
    expect(a.getActorSyncPlan).not.toHaveBeenCalled()
  })

  it('defers to a human GM when the service-GM is also connected', async () => {
    globalThis.game.user = { id: 'CFGServiceGM0000', isGM: true }
    globalThis.game.users = makeUsers([
      { id: 'CFGServiceGM0000', active: true, isGM: true },
      { id: 'gm-a', active: true, isGM: true },
    ])
    const a = api([planItem()])
    await new ActorPullSync(a, 'inst-1').tick()
    expect(a.getActorSyncPlan).not.toHaveBeenCalled()
  })

  it('acts when the service-GM is the only connected GM', async () => {
    globalThis.game.user = { id: 'CFGServiceGM0000', isGM: true }
    globalThis.game.users = makeUsers([{ id: 'CFGServiceGM0000', active: true, isGM: true }])
    const a = api([planItem()])
    await new ActorPullSync(a, 'inst-1').tick()
    expect(a.getActorSyncPlan).toHaveBeenCalled()
  })
})

describe('ActorPullSync — create (the fp#46 hole)', () => {
  it('CREATES an actor that is not in this world and has never been pushed', async () => {
    // Inverted from character-pull-sync.test.js "skips a record whose actor is not in
    // game.actors" — that assertion is exactly what pinned the bug in place.
    const a = api([planItem()])
    await new ActorPullSync(a, 'inst-1').tick()

    expect(globalThis.Actor.create).toHaveBeenCalledTimes(1)
    const [doc, opts] = globalThis.Actor.create.mock.calls[0]
    expect(doc._id).toBe(ACTOR_ID)
    expect(opts).toEqual({ keepId: true }) // without this the id is dropped → duplicates forever
  })

  it('does NOT re-create an actor the world already has', async () => {
    seedActors({ [ACTOR_ID]: liveActor() })
    const a = api([planItem({ everPushed: true })])
    await new ActorPullSync(a, 'inst-1').tick()
    expect(globalThis.Actor.create).not.toHaveBeenCalled()
  })

  it('reports world_deleted instead of resurrecting an actor the GM deleted', async () => {
    // Absent + everPushed means the world had it and no longer does. Re-creating it
    // every 30s would make the actor un-deletable.
    const a = api([planItem({ everPushed: true })])
    await new ActorPullSync(a, 'inst-1').tick()

    expect(globalThis.Actor.create).not.toHaveBeenCalled()
    const [, , , results] = a.ackActorSync.mock.calls[0]
    expect(results[0]).toMatchObject({ ok: false, code: 'world_deleted' })
  })
})

describe('ActorPullSync — update', () => {
  it('updates the parent without items/effects and reconciles them separately', async () => {
    const live = liveActor({ itemIds: ['itemOLD00000000A'] })
    seedActors({ [ACTOR_ID]: live })
    const a = api([planItem({ everPushed: true })])
    await new ActorPullSync(a, 'inst-1').tick()

    // Embedded collections merge by _id through a parent update and never REMOVE —
    // so they must be reconciled explicitly, exactly like journal pages.
    const payload = live.update.mock.calls[0][0]
    expect(payload.items).toBeUndefined()
    expect(payload.effects).toBeUndefined()
    expect(live.createEmbeddedDocuments).toHaveBeenCalledWith('Item', [expect.objectContaining({ _id: 'itemAAAAAAAAAAAA' })], { keepId: true })
    expect(live.deleteEmbeddedDocuments).toHaveBeenCalledWith('Item', ['itemOLD00000000A'])
  })

  it('does NOT emit deletion markers — they silently void the whole update', async () => {
    // Verified against real dnd5e 5.3.3 (specs/actor-pull-sync.spec.js): a payload
    // carrying `-=` markers for fields the platform doc doesn't model (`_stats`,
    // `prototypeToken`, `img`, `folder`, `sort`) makes update() a SILENT no-op — it
    // resolves, nothing throws, and the change we wanted never lands. The trade is
    // stated in the service header: a platform-side removal does not propagate.
    const live = liveActor()
    live.toObject = () => ({ _id: ACTOR_ID, name: 'Stale', type: 'character', system: { gone: 1 }, items: [], effects: [], _stats: { modifiedTime: 1 } })
    seedActors({ [ACTOR_ID]: live })
    const a = api([planItem({ everPushed: true, docData: { _id: ACTOR_ID, name: 'Aria', type: 'character', system: {}, items: [] } })])
    await new ActorPullSync(a, 'inst-1').tick()

    const payload = live.update.mock.calls[0][0]
    expect(Object.keys(payload).some((k) => k.startsWith('-='))).toBe(false)
    expect(JSON.stringify(payload)).not.toContain('-=')
    expect(payload.name).toBe('Aria')
  })

  it('recreates with keepId when the type changed — update() cannot change type', async () => {
    seedActors({ [ACTOR_ID]: liveActor({ type: 'npc' }) })
    const live = globalThis.game.actors.get(ACTOR_ID)
    const a = api([planItem({ everPushed: true })]) // docData.type === 'character'
    await new ActorPullSync(a, 'inst-1').tick()

    expect(live.delete).toHaveBeenCalled()
    expect(globalThis.Actor.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'character' }), { keepId: true })
  })
})

describe('ActorPullSync — refusals', () => {
  it('refuses a doc built for another game system instead of throw-looping', async () => {
    const a = api([planItem({ systemId: 'cyphersystem' })])
    await new ActorPullSync(a, 'inst-1').tick()

    expect(globalThis.Actor.create).not.toHaveBeenCalled()
    expect(a.ackActorSync.mock.calls[0][3][0]).toMatchObject({ ok: false, code: 'system_mismatch' })
  })

  it('acks a health-probe refusal as an error rather than throwing', async () => {
    globalThis.CONFIG.Actor.documentClass = function Bad() {
      throw new Error('bad field')
    }
    const a = api([planItem()])
    await new ActorPullSync(a, 'inst-1').tick()

    expect(globalThis.Actor.create).not.toHaveBeenCalled()
    expect(a.ackActorSync.mock.calls[0][3][0].ok).toBe(false)
  })
})

describe('ActorPullSync — the ack contract', () => {
  it('echoes the doc it wrote and the claim it satisfied', async () => {
    const item = planItem({ claimedAt: '2026-07-25T12:00:00.000Z' })
    const a = api([item])
    await new ActorPullSync(a, 'inst-1').tick()

    const [installId, worldId, systemId, results] = a.ackActorSync.mock.calls[0]
    expect(installId).toBe('inst-1')
    expect(worldId).toBe('world-folder')
    expect(systemId).toBe('dnd5e')
    expect(results[0]).toEqual({
      characterId: 'char_1',
      foundryActorId: ACTOR_ID,
      ok: true,
      docData: item.docData,
      claimedAt: '2026-07-25T12:00:00.000Z',
    })
  })

  it('one bad actor does not stop the rest', async () => {
    const good = planItem({ characterId: 'char_2', foundryActorId: 'DerivedActor0002' })
    const bad = planItem({ characterId: 'char_3', foundryActorId: 'DerivedActor0003', docData: null })
    const a = api([bad, good])
    await new ActorPullSync(a, 'inst-1').tick()

    const results = a.ackActorSync.mock.calls[0][3]
    expect(results.find((r) => r.characterId === 'char_3').ok).toBe(false)
    expect(results.find((r) => r.characterId === 'char_2').ok).toBe(true)
  })

  it('an empty plan does nothing and does not ack', async () => {
    const a = api([])
    await new ActorPullSync(a, 'inst-1').tick()
    expect(a.ackActorSync).not.toHaveBeenCalled()
    expect(globalThis.Actor.create).not.toHaveBeenCalled()
  })

  it('sends the world system so the server can plan for it', async () => {
    const a = api([planItem()])
    await new ActorPullSync(a, 'inst-1').tick()
    expect(a.getActorSyncPlan).toHaveBeenCalledWith('inst-1', 'world-folder', 'dnd5e')
  })

  it('does not overlap ticks', async () => {
    const a = api([planItem()])
    let release
    a.getActorSyncPlan = jest.fn(() => new Promise((r) => (release = () => r({ data: [] }))))
    const sync = new ActorPullSync(a, 'inst-1')
    const first = sync.tick()
    await sync.tick()
    expect(a.getActorSyncPlan).toHaveBeenCalledTimes(1)
    release()
    await first
  })
})
