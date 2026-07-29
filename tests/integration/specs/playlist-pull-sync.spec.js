/**
 * Playlist write-back against a REAL FoundryVTT v14 world (dt#249).
 *
 * What is genuinely playlist-specific and MUST be proven live:
 *
 *   1. ⚠️ `playing` never reaches the world — parent OR sound, update OR create. The
 *      dt#249 probe measured that both are settable through a plain update and both
 *      survive create, which would start audio for every connected client. The engine's
 *      stripFields + per-embedded stripFields must actually prevent it.
 *   2. The embedded `sounds` collection reconciles by _id (edit / drop / create).
 *
 * Transport is stubbed, Foundry is real.
 */

import { test, expect } from '@playwright/test'
import { ensureInGame } from '../shared/foundry-login.mjs'

const MODULE_URL = '/modules/crit-fumble-core/scripts/services/playlist-pull-sync.js'

const PLAYLIST_ID = 'CfgPlistLiveTs01'

function planItem(over = {}) {
  const { docData: docOver, ...rest } = over
  return {
    foundryPlaylistId: PLAYLIST_ID,
    everPushed: true,
    claimedAt: '2026-07-28T12:00:00.000Z',
    removedPaths: [],
    docData: {
      _id: PLAYLIST_ID,
      name: 'Tavern Ambience',
      mode: 0,
      sounds: [
        { _id: 'CfgPlSoundLive01', name: 'Fireplace', path: 'sounds/notify.wav', volume: 0.6 },
        { _id: 'CfgPlSoundLive02', name: 'Chatter', path: 'sounds/notify.wav', volume: 0.4 },
      ],
      ...docOver,
    },
    ...rest,
  }
}

async function runTick(page, plan) {
  return page.evaluate(
    async ({ plan, moduleUrl, playlistId }) => {
      const { PlaylistPullSync } = await import(moduleUrl)
      const acked = []
      const api = {
        getPlaylistSyncPlan: async () => ({ data: plan }),
        ackPlaylistSync: async (_inst, _world, results) => {
          acked.push(...results)
          return { data: { recorded: results.length } }
        },
      }
      await new PlaylistPullSync(api, 'inst-live-test').tick()

      const doc = game.playlists.get(playlistId)
      return {
        acked,
        found: !!doc,
        name: doc?.name ?? null,
        playing: doc?.playing ?? null,
        sounds: doc ? doc.sounds.contents.map((s) => ({ id: s.id, name: s.name, playing: s.playing })) : null,
        createdAt: doc?._stats?.createdTime ?? null,
      }
    },
    { plan, moduleUrl: MODULE_URL, playlistId: PLAYLIST_ID },
  )
}

async function seed(page, over = {}) {
  return page.evaluate(
    async ({ id, over }) => {
      for (const p of game.playlists.filter((p) => p.id === id)) await p.delete()
      await Playlist.create(
        {
          _id: id,
          name: 'Tavern Ambience',
          mode: 0,
          sounds: [
            { _id: 'CfgPlSoundLive01', name: 'Fireplace', path: 'sounds/notify.wav', volume: 0.6 },
            { _id: 'CfgPlSoundLive02', name: 'Chatter', path: 'sounds/notify.wav', volume: 0.4 },
          ],
          ...over,
        },
        { keepId: true },
      )
      return game.playlists.get(id)?._stats?.createdTime ?? null
    },
    { id: PLAYLIST_ID, over },
  )
}

async function cleanup(page) {
  await page.evaluate(async (id) => {
    for (const p of game.playlists.filter((p) => p.id === id)) await p.delete()
  }, PLAYLIST_ID)
}

test.describe('Playlist write-back against real Foundry', () => {
  test.beforeEach(async ({ page }) => {
    await ensureInGame(page)
    await page.waitForFunction(() => window.CFGCore && game?.ready, { timeout: 30_000 })
    await cleanup(page)
  })

  test.afterEach(async ({ page }) => {
    await cleanup(page)
  })

  test('a doc carrying playing:true (parent + sound) is written WITHOUT starting playback', async ({ page }) => {
    // A hostile-or-buggy plan: playback state on the parent AND on a sound. The probe
    // measured both genuinely stick when written — so the strip must hold on UPDATE.
    await seed(page)
    const res = await runTick(page, [
      planItem({
        docData: {
          name: 'Tavern (edited)',
          playing: true,
          sounds: [
            { _id: 'CfgPlSoundLive01', name: 'Fireplace (louder)', path: 'sounds/notify.wav', volume: 1, playing: true, pausedTime: 9 },
            { _id: 'CfgPlSoundLive02', name: 'Chatter', path: 'sounds/notify.wav', volume: 0.4 },
          ],
        },
      }),
    ])

    expect(res.name).toBe('Tavern (edited)')
    expect(res.playing).toBe(false) // stripped — audio did not start
    expect(res.sounds.find((s) => s.id === 'CfgPlSoundLive01')).toMatchObject({ name: 'Fireplace (louder)', playing: false })
    expect(res.acked[0]).toMatchObject({ foundryPlaylistId: PLAYLIST_ID, ok: true })
  })

  test('the strip holds on CREATE too — the path that burned Scene.active', async ({ page }) => {
    // Nothing seeded, everPushed false → the engine CREATES from docData verbatim.
    const res = await runTick(page, [
      planItem({
        everPushed: false,
        docData: {
          playing: true,
          sounds: [{ _id: 'CfgPlSoundLive01', name: 'Fireplace', path: 'sounds/notify.wav', playing: true, pausedTime: 4 }],
        },
      }),
    ])

    expect(res.found).toBe(true)
    expect(res.playing).toBe(false)
    expect(res.sounds[0].playing).toBe(false)
    expect(res.acked[0].ok).toBe(true)
  })

  test('reconciles sounds by _id: edit, drop, create', async ({ page }) => {
    const createdBefore = await seed(page)
    const res = await runTick(page, [
      planItem({
        docData: {
          sounds: [
            { _id: 'CfgPlSoundLive01', name: 'Fireplace (edited)', path: 'sounds/notify.wav', volume: 0.9 },
            { _id: 'CfgPlSoundLive03', name: 'Rain', path: 'sounds/notify.wav', volume: 0.3 },
          ],
        },
      }),
    ])

    expect(res.sounds.map((s) => ({ id: s.id, name: s.name }))).toEqual([
      { id: 'CfgPlSoundLive01', name: 'Fireplace (edited)' },
      { id: 'CfgPlSoundLive03', name: 'Rain' },
    ])
    expect(res.createdAt).toBe(createdBefore) // updated in place
    expect(res.acked[0].ok).toBe(true)
  })

  test('reports world_deleted rather than re-creating a playlist the GM deleted', async ({ page }) => {
    const res = await runTick(page, [planItem()])
    expect(res.found).toBe(false)
    expect(res.acked[0]).toMatchObject({ ok: false, code: 'world_deleted' })
  })
})
