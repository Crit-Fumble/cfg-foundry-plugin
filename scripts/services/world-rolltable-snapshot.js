/**
 * World RollTable snapshot (dt#249, stage 6 of dt#243) — mirror a Foundry world's
 * RollTables to the platform so PlayTable can list and edit them offline. Sibling of
 * world-macro-snapshot.js; same single-writer election, debounced deltas, and
 * full-sweep reconcile.
 *
 * Tables are small (a formula + a results array of text rows), so the whole collection
 * ships every sweep, like macros.
 *
 * ⚠️ The one genuinely rolltable-specific wrinkle: a table's CONTENT lives in its
 * embedded `results`, and editing an embedded document fires the EMBEDDED document's
 * hooks (create/update/deleteTableResult), not the parent's — and does not advance the
 * parent's `_stats.modifiedTime` (measured, dt#247). So this service listens to the
 * TableResult hooks too and marks the PARENT dirty, or every ordinary row edit would
 * wait up to 15 minutes for the full sweep.
 *
 * GM-only and elected-single-writer, exactly like the macro mirror: every GM client
 * sees the same `game.tables`, so an unelected client would only duplicate writes.
 */

'use strict'

const LOG = 'CFG Core | WorldRollTables |'
const FULL_SWEEP_MS = 15 * 60 * 1000
const DELTA_DEBOUNCE_MS = 5000
const SERVICE_GM_ID = 'cfgservicegm0001'
const MAX_BATCH = 100

export class WorldRollTableSnapshot {
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

    this._register('createRollTable', (table) => this._onChanged(table))
    this._register('updateRollTable', (table) => this._onChanged(table))
    this._register('deleteRollTable', () => this._onDeleted())
    // Embedded results: their hooks carry the RESULT; the parent table is what we push.
    this._register('createTableResult', (result) => this._onChanged(result?.parent))
    this._register('updateTableResult', (result) => this._onChanged(result?.parent))
    this._register('deleteTableResult', (result) => this._onChanged(result?.parent))

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

  _onChanged(table) {
    if (!this._running || !table?.id) return
    this._dirty.add(table.id)
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

  /** The wire shape for one table: the full source object, embedded results included.
   *  Sending the whole doc keeps us honest ("mirror real Foundry documents, never invent
   *  a format") and carries every result's own `_stats` clock — which the server's deep
   *  LWW comparison (worldEditWinsDeep) depends on. */
  _serialize(table) {
    try {
      return table.toObject()
    } catch {
      return null
    }
  }

  _allTables() {
    return game.tables?.contents ?? []
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

    const tables = ids.map((id) => game.tables.get(id)).filter(Boolean).map((t) => this._serialize(t)).filter(Boolean)
    if (tables.length > 0) await this._pushBatches(tables)
    if (needsReconcile) await this._reconcile()
  }

  async _fullSweep() {
    if (!this._isReporter()) return
    const serialized = this._allTables().map((t) => this._serialize(t)).filter(Boolean)
    await this._pushBatches(serialized)
    await this._reconcile()
  }

  async _pushBatches(tables) {
    for (let i = 0; i < tables.length; i += MAX_BATCH) {
      await this._api.pushWorldRollTables(this._worldId, { tables: tables.slice(i, i + MAX_BATCH) })
    }
  }

  /** Tell the platform the authoritative id set so rows for tables deleted in the world are dropped. */
  async _reconcile() {
    const keepTableIds = this._allTables().map((t) => t.id).filter(Boolean)
    await this._api.pushWorldRollTables(this._worldId, { reconcile: true, keepTableIds })
  }
}
