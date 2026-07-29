/**
 * CFG Playlist Pull-Sync (dt#249) — the playlist CONFIG for the generic engine.
 *
 * Macro-shaped lifecycle (no platform-native creation path; the claim is the queue), with
 * ONE embedded collection — `sounds` — where the playlist's content lives.
 *
 * ## ⚠️ `playing` is the Scene.active of audio — MEASURED (v14, dt#249 probe)
 *
 * `Playlist.playing` and `PlaylistSound.playing` are both settable through a PLAIN
 * update, and both SURVIVE create — so a doc carrying them starts audio for every
 * connected client. Stripped on BOTH sides (the dt#246 lesson: a server-only strip is
 * insufficient because the create path hands the doc straight to Playlist.create):
 * the server never mirrors the fields, and this config strips the parent's `playing`
 * plus every sound's `playing`/`pausedTime` via the engine's strip knobs.
 *
 * ## Other measured facts
 *
 *   · `-=description` and `-=fade` markers work; `-=sort` is accepted and silently
 *     ignored (it WORKS on a Macro — per-type as always). Nested flags markers work.
 *   · No `system` block, no top-level `type`.
 */

'use strict'

import { DocPullSync } from './doc-pull-sync.js'

/** @type {import('./doc-pull-sync.js').DocSyncConfig} */
const PLAYLIST_CONFIG = {
  label: 'PlaylistPull',
  noun: 'playlist',
  collection: () => game.playlists,
  DocClass: () => Playlist,
  probeClass: () => CONFIG?.Playlist?.documentClass,
  checkSystem: false,
  // NEVER write `playing` — see the header.
  stripFields: ['playing'],
  platformIdKey: 'platformId',
  foundryIdKey: 'foundryPlaylistId',
  getPlan: (api, inst, world) => api.getPlaylistSyncPlan(inst, world),
  ack: (api, inst, world, _system, results) => api.ackPlaylistSync(inst, world, results),
  embedded: [
    // `pausedTime` rides along with `playing`: a resume position only means anything to a
    // playback state we refuse to write.
    { name: 'PlaylistSound', field: 'sounds', of: (live) => live.sounds, stripFields: ['playing', 'pausedTime'] },
  ],
}

export class PlaylistPullSync extends DocPullSync {
  /**
   * @param {import('../clients/api-client.js').CoreAPIClient} apiClient
   * @param {string} installationId
   */
  constructor(apiClient, installationId) {
    super(apiClient, installationId, PLAYLIST_CONFIG)
  }
}
