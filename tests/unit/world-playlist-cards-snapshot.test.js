/**
 * World Playlist + Cards snapshots (dt#249).
 *
 * Both are the world-rolltable-snapshot pattern (whose suite pins the shared election /
 * sweep / reconcile behaviour in full); here each service's essentials are pinned:
 * full-sweep push + reconcile with the right wire keys, the embedded-child→parent dirty
 * mapping, and that docs ship verbatim (playback state INCLUDED — the server owns the
 * sanitize, one side only, so the two can never disagree about what was dropped).
 */

import { jest } from '@jest/globals'

const playlist = (id, over = {}) => ({
  id,
  toObject: () => ({
    _id: id,
    name: `P-${id}`,
    playing: true, // ships verbatim; the SERVER strips playback state at ingest
    sounds: [{ _id: `${id}-s1`, name: 'song', path: 'a.ogg', playing: true, pausedTime: 3 }],
    ...over,
  }),
})

const stack = (id, over = {}) => ({
  id,
  toObject: () => ({
    _id: id,
    name: `C-${id}`,
    type: 'deck',
    cards: [{ _id: `${id}-c1`, name: 'Ace', type: 'base', value: 1 }],
    ...over,
  }),
})

function setupGame({ playlists = [], stacks = [], userId = 'gm1', gms = ['gm1'] } = {}) {
  const pMap = new Map(playlists.map((p) => [p.id, p]))
  const cMap = new Map(stacks.map((c) => [c.id, c]))
  globalThis.game = {
    world: { id: 'test-world' },
    user: { id: userId, isGM: true },
    users: gms.map((id) => ({ id, active: true, isGM: true })),
    playlists: { contents: playlists, size: playlists.length, get: (id) => pMap.get(id) },
    cards: { contents: stacks, size: stacks.length, get: (id) => cMap.get(id) },
  }
}

describe('WorldPlaylistSnapshot', () => {
  it('full sweep pushes every playlist verbatim (sounds + playback state), then reconciles', async () => {
    setupGame({ playlists: [playlist('a'), playlist('b')] })
    jest.resetModules()
    const { WorldPlaylistSnapshot } = await import('../../scripts/services/world-playlist-snapshot.js')
    const calls = []
    const svc = new WorldPlaylistSnapshot({ pushWorldPlaylists: async (w, body) => { calls.push(body); return {} } })
    svc._running = true
    await svc._fullSweep()

    expect(calls[0].playlists.map((p) => p._id)).toEqual(['a', 'b'])
    // Verbatim doc — the server owns the playback-state strip.
    expect(calls[0].playlists[0].playing).toBe(true)
    expect(calls[0].playlists[0].sounds[0]).toMatchObject({ playing: true, pausedTime: 3 })
    expect(calls[1]).toEqual({ reconcile: true, keepPlaylistIds: ['a', 'b'] })
  })

  it('an embedded PlaylistSound change marks the PARENT playlist dirty', async () => {
    setupGame({ playlists: [playlist('a'), playlist('b')] })
    jest.resetModules()
    const { WorldPlaylistSnapshot } = await import('../../scripts/services/world-playlist-snapshot.js')
    const calls = []
    const svc = new WorldPlaylistSnapshot({ pushWorldPlaylists: async (w, body) => { calls.push(body); return {} } })
    svc._running = true

    const fakeSound = { id: 'a-s1', parent: game.playlists.get('a') }
    svc._onChanged(fakeSound.parent) // what the PlaylistSound hook handlers do
    await svc._flushDeltas()

    expect(calls[0].playlists.map((p) => p._id)).toEqual(['a'])
  })

  it('an UNELECTED reporter pushes nothing', async () => {
    setupGame({ playlists: [playlist('a')], userId: 'gm2', gms: ['gm1', 'gm2'] })
    jest.resetModules()
    const { WorldPlaylistSnapshot } = await import('../../scripts/services/world-playlist-snapshot.js')
    const calls = []
    const svc = new WorldPlaylistSnapshot({ pushWorldPlaylists: async (w, body) => { calls.push(body); return {} } })
    svc._running = true
    await svc._fullSweep()

    expect(calls).toEqual([])
  })
})

describe('WorldCardsSnapshot', () => {
  it('full sweep pushes every stack (embedded cards included), then reconciles', async () => {
    setupGame({ stacks: [stack('x'), stack('y')] })
    jest.resetModules()
    const { WorldCardsSnapshot } = await import('../../scripts/services/world-cards-snapshot.js')
    const calls = []
    const svc = new WorldCardsSnapshot({ pushWorldCards: async (w, body) => { calls.push(body); return {} } })
    svc._running = true
    await svc._fullSweep()

    expect(calls[0].stacks.map((c) => c._id)).toEqual(['x', 'y'])
    expect(calls[0].stacks[0].cards).toHaveLength(1)
    expect(calls[1]).toEqual({ reconcile: true, keepStackIds: ['x', 'y'] })
  })

  it('an embedded Card change marks the PARENT stack dirty', async () => {
    setupGame({ stacks: [stack('x'), stack('y')] })
    jest.resetModules()
    const { WorldCardsSnapshot } = await import('../../scripts/services/world-cards-snapshot.js')
    const calls = []
    const svc = new WorldCardsSnapshot({ pushWorldCards: async (w, body) => { calls.push(body); return {} } })
    svc._running = true

    const fakeCard = { id: 'y-c1', parent: game.cards.get('y') }
    svc._onChanged(fakeCard.parent) // what the Card hook handlers do
    await svc._flushDeltas()

    expect(calls[0].stacks.map((c) => c._id)).toEqual(['y'])
  })
})
