/**
 * World Playlist snapshot (dt#249, stage 6 of dt#243) — mirror a Foundry world's
 * Playlists to the platform so PlayTable can list and edit them offline. Sibling of
 * world-rolltable-snapshot.js; same single-writer election, debounced deltas, and
 * full-sweep reconcile.
 *
 * A playlist's CONTENT lives in its embedded `sounds`, so this service listens to the
 * PlaylistSound hooks too and marks the PARENT dirty (the dt#247/dt#249 embedded rule —
 * a sound edit fires the sound's hooks, not the playlist's, and does not advance the
 * parent's clock).
 *
 * The doc ships verbatim (`toObject()`, `playing` state and all); the SERVER strips the
 * dangerous playback fields at ingest so the mirror never stores them. Stripping here
 * too would be harmless, but the mirror rule is "carry the documents faithfully" — one
 * side owns the sanitize so the two can never disagree about what was dropped.
 *
 * GM-only and elected-single-writer, exactly like the other mirrors.
 */

'use strict'

const LOG = 'CFG Core | WorldPlaylists |'
const FULL_SWEEP_MS = 15 * 60 * 1000
const DELTA_DEBOUNCE_MS = 5000
const SERVICE_GM_ID = 'cfgservicegm0001'
const MAX_BATCH = 100

export class WorldPlaylistSnapshot {
  /** @param {import('../clients/api-client.js').CoreAPIClient} apiClient */
  constructor(apiClient) {
    this._api = apiClient
    this._worldId = game.world?.id ?? null
    this._sweepHandle = null
    this._debounceHandle = null
    this._dirty = new Set()
    this._needsReconcile = false
    this._hooks = []
    this._running = false
  }

  start() {
    if (!this._worldId) return
    this._running = true

    this._fullSweep().catch((err) => console.debug?.(`${LOG} initial sweep skipped:`, err?.message || err))

    this._sweepHandle = setInterval(() => {
      this._fullSweep().catch((err) => console.debug?.(`${LOG} sweep skipped:`, err?.message || err))
    }, FULL_SWEEP_MS)

    this._register('createPlaylist', (playlist) => this._onChanged(playlist))
    this._register('updatePlaylist', (playlist) => this._onChanged(playlist))
    this._register('deletePlaylist', () => this._onDeleted())
    // Embedded sounds: their hooks carry the SOUND; the parent playlist is what we push.
    this._register('createPlaylistSound', (sound) => this._onChanged(sound?.parent))
    this._register('updatePlaylistSound', (sound) => this._onChanged(sound?.parent))
    this._register('deletePlaylistSound', (sound) => this._onChanged(sound?.parent))

    console.log(`${LOG} started for world ${this._worldId}`)
  }

  stop() {
    this._running = false
    if (this._sweepHandle) { clearInterval(this._sweepHandle); this._sweepHandle = null }
    if (this._debounceHandle) { clearTimeout(this._debounceHandle); this._debounceHandle = null }
    for (const [name, fn] of this._hooks) Hooks.off(name, fn)
    this._hooks = []
  }

  _register(name, fn) {
    Hooks.on(name, fn)
    this._hooks.push([name, fn])
  }

  /** Elected reporter: smallest human-GM id, or the lone service-GM — one writer per world. */
  _electedReporterId() {
    const gms = game.users.filter((u) => u.active && u.isGM)
    if (gms.length === 0) return null
    const humans = gms.filter((u) => u.id !== SERVICE_GM_ID)
    const pool = humans.length ? humans : gms
    return pool.map((u) => u.id).sort()[0]
  }

  _isReporter() {
    const id = this._electedReporterId()
    return !!id && game.user?.id === id
  }

  _onChanged(playlist) {
    if (!this._running || !playlist?.id) return
    this._dirty.add(playlist.id)
    this._scheduleFlush()
  }

  _onDeleted() {
    if (!this._running) return
    this._needsReconcile = true
    this._scheduleFlush()
  }

  _scheduleFlush() {
    if (this._debounceHandle) return
    this._debounceHandle = setTimeout(() => {
      this._debounceHandle = null
      this._flushDeltas().catch((err) => console.debug?.(`${LOG} delta flush skipped:`, err?.message || err))
    }, DELTA_DEBOUNCE_MS)
  }

  /** The wire shape for one playlist: the full source object, embedded sounds included —
   *  every sound's own `_stats` clock is what the server's deep LWW comparison reads. */
  _serialize(playlist) {
    try {
      return playlist.toObject()
    } catch {
      return null
    }
  }

  _allPlaylists() {
    return game.playlists?.contents ?? []
  }

  async _flushDeltas() {
    if (!this._isReporter()) {
      this._dirty.clear()
      this._needsReconcile = false
      return
    }
    const ids = [...this._dirty]
    this._dirty.clear()
    const needsReconcile = this._needsReconcile
    this._needsReconcile = false

    const playlists = ids.map((id) => game.playlists.get(id)).filter(Boolean).map((p) => this._serialize(p)).filter(Boolean)
    if (playlists.length > 0) await this._pushBatches(playlists)
    if (needsReconcile) await this._reconcile()
  }

  async _fullSweep() {
    if (!this._isReporter()) return
    const serialized = this._allPlaylists().map((p) => this._serialize(p)).filter(Boolean)
    await this._pushBatches(serialized)
    await this._reconcile()
  }

  async _pushBatches(playlists) {
    for (let i = 0; i < playlists.length; i += MAX_BATCH) {
      await this._api.pushWorldPlaylists(this._worldId, { playlists: playlists.slice(i, i + MAX_BATCH) })
    }
  }

  /** Tell the platform the authoritative id set so rows for playlists deleted in the world are dropped. */
  async _reconcile() {
    const keepPlaylistIds = this._allPlaylists().map((p) => p.id).filter(Boolean)
    await this._api.pushWorldPlaylists(this._worldId, { reconcile: true, keepPlaylistIds })
  }
}
