/**
 * World Cards snapshot (dt#249, stage 6 of dt#243) — mirror a Foundry world's card
 * stacks (decks / hands / piles) to the platform so PlayTable can list and edit them
 * offline. Sibling of world-playlist-snapshot.js; same single-writer election, debounced
 * deltas, and full-sweep reconcile.
 *
 * A stack's CONTENT lives in its embedded `cards`, so this service listens to the Card
 * hooks too and marks the PARENT dirty (the dt#247/dt#249 embedded rule). Dealing a card
 * between stacks fires hooks on BOTH the origin and destination stacks' cards, so both
 * parents end up dirty and both mirror correctly.
 *
 * GM-only and elected-single-writer, exactly like the other mirrors.
 */

'use strict'

const LOG = 'CFG Core | WorldCards |'
const FULL_SWEEP_MS = 15 * 60 * 1000
const DELTA_DEBOUNCE_MS = 5000
const SERVICE_GM_ID = 'cfgservicegm0001'
const MAX_BATCH = 50

export class WorldCardsSnapshot {
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

    this._register('createCards', (stack) => this._onChanged(stack))
    this._register('updateCards', (stack) => this._onChanged(stack))
    this._register('deleteCards', () => this._onDeleted())
    // Embedded cards: their hooks carry the CARD; the parent stack is what we push.
    this._register('createCard', (card) => this._onChanged(card?.parent))
    this._register('updateCard', (card) => this._onChanged(card?.parent))
    this._register('deleteCard', (card) => this._onChanged(card?.parent))

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

  _onChanged(stack) {
    if (!this._running || !stack?.id) return
    this._dirty.add(stack.id)
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

  /** The wire shape for one stack: the full source object, embedded cards included —
   *  every card's own `_stats` clock is what the server's deep LWW comparison reads. */
  _serialize(stack) {
    try {
      return stack.toObject()
    } catch {
      return null
    }
  }

  _allStacks() {
    return game.cards?.contents ?? []
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

    const stacks = ids.map((id) => game.cards.get(id)).filter(Boolean).map((c) => this._serialize(c)).filter(Boolean)
    if (stacks.length > 0) await this._pushBatches(stacks)
    if (needsReconcile) await this._reconcile()
  }

  async _fullSweep() {
    if (!this._isReporter()) return
    const serialized = this._allStacks().map((c) => this._serialize(c)).filter(Boolean)
    await this._pushBatches(serialized)
    await this._reconcile()
  }

  async _pushBatches(stacks) {
    for (let i = 0; i < stacks.length; i += MAX_BATCH) {
      await this._api.pushWorldCards(this._worldId, { stacks: stacks.slice(i, i + MAX_BATCH) })
    }
  }

  /** Tell the platform the authoritative id set so rows for stacks deleted in the world are dropped. */
  async _reconcile() {
    const keepStackIds = this._allStacks().map((c) => c.id).filter(Boolean)
    await this._api.pushWorldCards(this._worldId, { reconcile: true, keepStackIds })
  }
}
