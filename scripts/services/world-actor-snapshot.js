/**
 * CFG World Actor Snapshot (cfs#17)
 *
 * Mirrors this world's actors to the Core platform so their character sheets
 * stay viewable on the web AFTER the VTT goes offline. This is the ONLY way the
 * data ever reaches the platform for a self-hosted Foundry — the platform never
 * sees that disk, so a push from inside the running world is the sole source.
 *
 * Single-reporter election: Foundry modules run in every connected client, so a
 * GM is elected to do the pushing — a human GM (lexicographically smallest id)
 * when present, falling back to the headless service-GM only when it is the lone
 * GM. A GM is required because only a GM sees every actor with full source data;
 * a player client would push a partial, permission-filtered view.
 *
 * Two cadences:
 *   - Full sweep on start + on a long interval — upserts every actor, then
 *     reconciles (drops platform rows whose actor was deleted). Also re-converges
 *     after a reporter handoff.
 *   - Live deltas via createActor/updateActor/deleteActor hooks, debounced to
 *     coalesce rapid edits (combat HP ticks, etc.).
 *
 * Auth + transport: the shared CoreAPIClient attaches the world's installation
 * API key (cfg-hosted) or paired key (self-hosted), with a session-cookie
 * fallback — identical to the world-status callback. All failures are non-fatal:
 * a missed push just means the platform serves a slightly older snapshot.
 */

'use strict'

const LOG = 'CFG Core | WorldActors |'

const FULL_SWEEP_MS = 10 * 60_000 // periodic safety-net sweep + reconcile
const DELTA_DEBOUNCE_MS = 5_000 // coalesce rapid actor edits before pushing
const BATCH_SIZE = 20 // actors per request — keeps each POST comfortably bounded

// Matches SERVICE_GM_NATIVE_ID in cfg-core-server. Preferred reporter is a human
// GM; the service-GM only reports when it is the sole connected GM.
const SERVICE_GM_ID = 'CFGServiceGM0000'

export class WorldActorSnapshot {
  /** @param {import('../clients/api-client.js').CoreAPIClient} apiClient */
  constructor(apiClient) {
    this._api = apiClient
    this._worldId = game.world?.id ?? null
    this._systemId = game.system?.id ?? null
    this._sweepHandle = null
    this._debounceHandle = null
    this._dirty = new Set() // actor ids changed since the last flush
    this._needsReconcile = false // a delete happened — drop stale rows on flush
    this._hooks = [] // [[hookName, fnRef]] for teardown
    this._running = false
  }

  /** Begin snapshotting. Call once on module ready in GM clients of a linked world. */
  start() {
    if (!this._worldId) return
    this._running = true

    // Initial full sweep once Foundry is settled (game.actors is populated by ready).
    this._fullSweep().catch((err) => console.debug?.(`${LOG} initial sweep skipped:`, err?.message || err))

    // Periodic safety-net sweep — catches missed hooks and reporter handoffs.
    this._sweepHandle = setInterval(() => {
      this._fullSweep().catch((err) => console.debug?.(`${LOG} sweep skipped:`, err?.message || err))
    }, FULL_SWEEP_MS)

    // Live deltas.
    this._register('createActor', (actor) => this._onActorChanged(actor))
    this._register('updateActor', (actor) => this._onActorChanged(actor))
    this._register('deleteActor', () => this._onActorDeleted())

    console.log(`${LOG} started for world ${this._worldId} (system ${this._systemId ?? 'unknown'})`)
  }

  stop() {
    this._running = false
    if (this._sweepHandle) {
      clearInterval(this._sweepHandle)
      this._sweepHandle = null
    }
    if (this._debounceHandle) {
      clearTimeout(this._debounceHandle)
      this._debounceHandle = null
    }
    for (const [name, fn] of this._hooks) Hooks.off(name, fn)
    this._hooks = []
  }

  _register(name, fn) {
    Hooks.on(name, fn)
    this._hooks.push([name, fn])
  }

  /** Elected reporter id: smallest human-GM id, or the lone service-GM. */
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

  _onActorChanged(actor) {
    if (!this._running || !actor?.id) return
    this._dirty.add(actor.id)
    this._scheduleFlush()
  }

  _onActorDeleted() {
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

  /** Serialize one actor for the wire — full source object (GM sees everything). */
  _serialize(actor) {
    try {
      return actor.toObject()
    } catch {
      return null
    }
  }

  _allActors() {
    return game.actors?.contents ?? []
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

    const actors = ids
      .map((id) => game.actors.get(id))
      .filter(Boolean)
      .map((a) => this._serialize(a))
      .filter(Boolean)

    if (actors.length > 0) await this._pushBatches(actors)
    if (needsReconcile) await this._reconcile()
  }

  async _fullSweep() {
    if (!this._isReporter()) return
    const all = this._allActors()
    const serialized = all.map((a) => this._serialize(a)).filter(Boolean)
    await this._pushBatches(serialized)
    await this._reconcile()
  }

  async _pushBatches(actors) {
    for (let i = 0; i < actors.length; i += BATCH_SIZE) {
      const batch = actors.slice(i, i + BATCH_SIZE)
      await this._api.pushWorldActors(this._worldId, { systemId: this._systemId, actors: batch })
    }
  }

  async _reconcile() {
    await this._api.pushWorldActors(this._worldId, {
      systemId: this._systemId,
      reconcile: true,
      keepActorIds: this._allActors().map((a) => a.id),
    })
  }
}
