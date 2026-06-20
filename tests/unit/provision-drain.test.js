/**
 * Runtime provision drain (cfs live-world SSO) — the GM-side half that creates
 * the reserved Foundry User docs so the proxy can SSO invited players into a
 * running world. Covers the drainer election, keepId+password create, the
 * idempotent + name-collision paths, and confirm-back.
 */

import { jest } from '@jest/globals'
import { ProvisionDrain } from '../../scripts/services/provision-drain.js'

/** Array-backed game.users collection that also exposes Foundry's `.get(id)`. */
function makeUsers(list) {
  const arr = [...list]
  arr.get = (id) => arr.find((u) => u.id === id)
  return arr
}

function api(pending = []) {
  return {
    getPendingProvisions: jest.fn(async () => ({ data: pending })),
    confirmProvision: jest.fn(async () => ({ data: { confirmed: true } })),
  }
}

const ALICE = { nativeUserId: 'ReservedId00000A', foundryUsername: 'Alice', role: 1, password: 'pw-derived' }

beforeEach(() => {
  globalThis.User = { create: jest.fn(async (d) => ({ id: d._id, name: d.name })) }
  game.world = { id: 'world-folder' }
})

describe('ProvisionDrain', () => {
  it('elected GM drainer creates the reserved user (keepId + password) and confirms', async () => {
    game.user = { id: 'gm-a', isGM: true }
    game.users = makeUsers([{ id: 'gm-a', active: true, isGM: true, name: 'GM' }])
    const a = api([ALICE])

    await new ProvisionDrain(a, 'inst-1')._tick()

    expect(User.create).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'ReservedId00000A', name: 'Alice', role: 1, password: 'pw-derived' }),
      { keepId: true },
    )
    expect(a.confirmProvision).toHaveBeenCalledWith('inst-1', 'world-folder', 'ReservedId00000A')
  })

  it('is idempotent: if the reserved id already exists, skips create but still confirms', async () => {
    game.user = { id: 'gm-a', isGM: true }
    game.users = makeUsers([
      { id: 'gm-a', active: true, isGM: true, name: 'GM' },
      { id: 'ReservedId00000A', active: false, isGM: false, name: 'Alice' },
    ])
    const a = api([ALICE])

    await new ProvisionDrain(a, 'inst-1')._tick()

    expect(User.create).not.toHaveBeenCalled()
    expect(a.confirmProvision).toHaveBeenCalledWith('inst-1', 'world-folder', 'ReservedId00000A')
  })

  it('disambiguates a name that collides with an existing (native) user', async () => {
    game.user = { id: 'gm-a', isGM: true }
    game.users = makeUsers([
      { id: 'gm-a', active: true, isGM: true, name: 'GM' },
      { id: 'native-1', active: false, isGM: false, name: 'Alice' }, // native same-name user
    ])
    const a = api([ALICE])

    await new ProvisionDrain(a, 'inst-1')._tick()

    expect(User.create).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'ReservedId00000A', name: 'Alice [Rese]' }),
      { keepId: true },
    )
  })

  it('stays quiet when another active GM has a smaller id (single-drainer election)', async () => {
    game.user = { id: 'gm-b', isGM: true }
    game.users = makeUsers([
      { id: 'gm-a', active: true, isGM: true, name: 'GM A' },
      { id: 'gm-b', active: true, isGM: true, name: 'GM B' },
    ])
    const a = api([ALICE])

    await new ProvisionDrain(a, 'inst-1')._tick()

    expect(a.getPendingProvisions).not.toHaveBeenCalled()
    expect(User.create).not.toHaveBeenCalled()
  })

  it('does nothing for a non-GM client', async () => {
    game.user = { id: 'player-1', isGM: false }
    game.users = makeUsers([{ id: 'player-1', active: true, isGM: false, name: 'Player' }])
    const a = api([ALICE])

    await new ProvisionDrain(a, 'inst-1')._tick()

    expect(a.getPendingProvisions).not.toHaveBeenCalled()
  })

  it('no-ops on an empty queue', async () => {
    game.user = { id: 'gm-a', isGM: true }
    game.users = makeUsers([{ id: 'gm-a', active: true, isGM: true, name: 'GM' }])
    const a = api([])

    await new ProvisionDrain(a, 'inst-1')._tick()

    expect(User.create).not.toHaveBeenCalled()
    expect(a.confirmProvision).not.toHaveBeenCalled()
  })

  it('one failed seat does not stop the others', async () => {
    game.user = { id: 'gm-a', isGM: true }
    game.users = makeUsers([{ id: 'gm-a', active: true, isGM: true, name: 'GM' }])
    const BOB = { nativeUserId: 'ReservedId00000B', foundryUsername: 'Bob', role: 1, password: 'pw2' }
    const a = api([ALICE, BOB])
    User.create.mockImplementationOnce(async () => {
      throw new Error('boom')
    })

    await new ProvisionDrain(a, 'inst-1')._tick()

    // Alice threw; Bob still created + confirmed.
    expect(User.create).toHaveBeenCalledTimes(2)
    expect(a.confirmProvision).toHaveBeenCalledTimes(1)
    expect(a.confirmProvision).toHaveBeenCalledWith('inst-1', 'world-folder', 'ReservedId00000B')
  })
})
