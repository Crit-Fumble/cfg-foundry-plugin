/**
 * World Journal snapshot (dt#247) — the world→platform leg that closes cs#186.
 *
 * The journal sync (#184) is desired-state relative to OUR OWN PUSH LOG, never to the world.
 * So once an entry is synced, a GM deleting it in Foundry is never noticed (it does not
 * appear in any plan — the baseline still matches), and a GM editing it silently WINS.
 *
 * This service supplies the missing facts. Sibling of world-macro-snapshot.js: same
 * single-writer election, debounced deltas, and full-sweep reconcile.
 *
 * DELIBERATELY NOT A MIRROR. The platform stores nothing from this for offline viewing —
 * hosted worlds already read their own LevelDB, and platform entries live in
 * CoreJournalEntry. It sends only what last-write-wins needs: the doc (whose
 * `_stats.modifiedTime` is Foundry's own server-stamped clock) and, on reconcile, the
 * authoritative id set.
 *
 * GM-only and elected-single-writer: every GM client sees the same `game.journal`, so an
 * unelected client would only duplicate writes.
 */

'use strict'

const LOG = 'CFG Core | WorldJournal |'
const FULL_SWEEP_MS = 15 * 60 * 1000
const DELTA_DEBOUNCE_MS = 5000
const SERVICE_GM_ID = 'CFGServiceGM0000'
const MAX_BATCH = 100

export class WorldJournalSnapshot {
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

    this._register('createJournalEntry', (entry) => this._onChanged(entry))
    this._register('updateJournalEntry', (entry) => this._onChanged(entry))
    this._register('deleteJournalEntry', () => this._onDeleted())
    // A page edit changes the PARENT entry's content, and the platform diffs whole entries.
    this._register('updateJournalEntryPage', (page) => this._onChanged(page?.parent))
    this._register('createJournalEntryPage', (page) => this._onChanged(page?.parent))
    this._register('deleteJournalEntryPage', (page) => this._onChanged(page?.parent))

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

  _onChanged(entry) {
    if (!this._running || !entry?.id) return
    this._dirty.add(entry.id)
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

  /** The full source object — `_stats.modifiedTime` is the whole point, so never trim it. */
  _serialize(entry) {
    try {
      return entry.toObject()
    } catch {
      return null
    }
  }

  _allEntries() {
    return game.journal?.contents ?? []
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

    const entries = ids.map((id) => game.journal.get(id)).filter(Boolean).map((e) => this._serialize(e)).filter(Boolean)
    if (entries.length > 0) await this._pushBatches(entries)
    if (needsReconcile) await this._reconcile()
  }

  async _fullSweep() {
    if (!this._isReporter()) return
    const serialized = this._allEntries().map((e) => this._serialize(e)).filter(Boolean)
    if (serialized.length > 0) await this._pushBatches(serialized)
    await this._reconcile()
  }

  async _pushBatches(entries) {
    for (let i = 0; i < entries.length; i += MAX_BATCH) {
      await this._api.pushWorldJournal(this._worldId, { entries: entries.slice(i, i + MAX_BATCH) })
    }
  }

  /** The authoritative id set, so entries the GM deleted in the world can be parked. */
  async _reconcile() {
    const keepEntryIds = this._allEntries().map((e) => e.id).filter(Boolean)
    await this._api.pushWorldJournal(this._worldId, { reconcile: true, keepEntryIds })
  }
}
