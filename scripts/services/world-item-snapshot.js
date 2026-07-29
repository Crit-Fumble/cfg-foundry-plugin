/**
 * World STANDALONE ITEM snapshot (dt#250, stage 7 of dt#243) — mirror a Foundry world's
 * Item DIRECTORY (game.items) to the platform so PlayTable can list and edit it offline.
 * Sibling of world-rolltable-snapshot.js; same single-writer election, debounced deltas,
 * and full-sweep reconcile.
 *
 * Actor-embedded items are NOT this service's business — they live inside each actor
 * and ride world-actor-snapshot.js.
 *
 * ⚠️ The genuinely item-specific wrinkle (the dt#247 rule again): an item's effects live
 * in its embedded `effects`, and editing an ActiveEffect fires the EFFECT's hooks — not
 * the item's — and does not advance the item's `_stats.modifiedTime` (measured
 * 2026-07-29). So this service listens to the ActiveEffect hooks too and marks the
 * PARENT dirty — but only when that parent is a STANDALONE item: an effect on an
 * actor-embedded item has `parent.parent` set and belongs to the actor snapshot.
 *
 * Items carry full system blocks, so batches are smaller than the rolltable sweep's.
 */

'use strict'

const LOG = 'CFG Core | WorldItems |'
const FULL_SWEEP_MS = 15 * 60 * 1000
const DELTA_DEBOUNCE_MS = 5000
const SERVICE_GM_ID = 'cfgservicegm0001'
const MAX_BATCH = 50

export class WorldItemSnapshot {
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

    // Only STANDALONE items: an embedded item's create/update/delete hooks carry a
    // document whose `parent` is the Actor — those changes are the actor snapshot's.
    this._register('createItem', (item) => this._onChanged(this._standalone(item)))
    this._register('updateItem', (item) => this._onChanged(this._standalone(item)))
    this._register('deleteItem', (item) => { if (this._standalone(item)) this._onDeleted() })
    // Embedded effects: their hooks carry the EFFECT; the parent item is what we push.
    // An effect whose parent has its own parent (actor-embedded item) is not ours.
    this._register('createActiveEffect', (eff) => this._onChanged(this._standalone(eff?.parent)))
    this._register('updateActiveEffect', (eff) => this._onChanged(this._standalone(eff?.parent)))
    this._register('deleteActiveEffect', (eff) => this._onChanged(this._standalone(eff?.parent)))

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

  /** The document iff it is a STANDALONE world item (in game.items, no parent, no pack). */
  _standalone(doc) {
    if (!doc?.id || doc.parent || doc.pack) return null
    return doc.documentName === 'Item' && game.items?.has(doc.id) ? doc : null
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

  _onChanged(item) {
    if (!this._running || !item?.id) return
    this._dirty.add(item.id)
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

  /** The wire shape: the full source object, embedded effects included — carries every
   *  effect's own `_stats` clock, which the server's worldEditWinsDeep depends on. */
  _serialize(item) {
    try {
      return item.toObject()
    } catch {
      return null
    }
  }

  _allItems() {
    return game.items?.contents ?? []
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

    const items = ids.map((id) => game.items.get(id)).filter(Boolean).map((i) => this._serialize(i)).filter(Boolean)
    if (items.length > 0) await this._pushBatches(items)
    if (needsReconcile) await this._reconcile()
  }

  async _fullSweep() {
    if (!this._isReporter()) return
    const serialized = this._allItems().map((i) => this._serialize(i)).filter(Boolean)
    await this._pushBatches(serialized)
    await this._reconcile()
  }

  async _pushBatches(items) {
    for (let i = 0; i < items.length; i += MAX_BATCH) {
      await this._api.pushWorldItems(this._worldId, { items: items.slice(i, i + MAX_BATCH) })
    }
  }

  /** Tell the platform the authoritative id set so rows for items deleted in the world are dropped. */
  async _reconcile() {
    const keepItemIds = this._allItems().map((i) => i.id).filter(Boolean)
    await this._api.pushWorldItems(this._worldId, { reconcile: true, keepItemIds })
  }
}
