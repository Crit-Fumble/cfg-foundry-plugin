/**
 * World Macro snapshot (dt#214, slice 1) — mirror a Foundry world's Macros to the platform so
 * PlayTable can list, edit (via the CodeMirror editor), and hotbar-assign them. Sibling of
 * world-actor-snapshot.js; same single-writer election, debounced deltas, and full-sweep reconcile.
 *
 * Macros are TINY (a name + a `command` string + a little metadata), so there is no content-volume
 * concern here — the whole collection ships every sweep. The interesting half is downstream, not
 * here: a `chat` macro's command runs in PlayTable's own chat pipeline, while a `script` macro is
 * edit-here / run-in-Foundry (owner decision — no arbitrary JS executes on the platform). This
 * service just carries the documents faithfully; it never interprets `command`.
 *
 * GM-only and elected-single-writer, exactly like the actor mirror: every GM client sees the same
 * `game.macros`, so an unelected client would only duplicate writes.
 */

'use strict'

const LOG = 'CFG Core | WorldMacros |'
const FULL_SWEEP_MS = 15 * 60 * 1000
const DELTA_DEBOUNCE_MS = 5000
const SERVICE_GM_ID = 'cfgservicegm0001'
const MAX_BATCH = 200

export class WorldMacroSnapshot {
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

    this._register('createMacro', (macro) => this._onChanged(macro))
    this._register('updateMacro', (macro) => this._onChanged(macro))
    this._register('deleteMacro', () => this._onDeleted())

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

  _onChanged(macro) {
    if (!this._running || !macro?.id) return
    this._dirty.add(macro.id)
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

  /** The wire shape for one macro. The full source object — the platform reads `command`, `type`,
   *  `scope`, `img`, `author`, `ownership`, `folder` off it; sending the whole doc keeps us honest
   *  ("mirror real Foundry macros, never invent a format") and future-proof against new fields. */
  _serialize(macro) {
    try {
      return macro.toObject()
    } catch {
      return null
    }
  }

  _allMacros() {
    return game.macros?.contents ?? []
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

    const macros = ids.map((id) => game.macros.get(id)).filter(Boolean).map((m) => this._serialize(m)).filter(Boolean)
    if (macros.length > 0) await this._pushBatches(macros)
    if (needsReconcile) await this._reconcile()
  }

  async _fullSweep() {
    if (!this._isReporter()) return
    const serialized = this._allMacros().map((m) => this._serialize(m)).filter(Boolean)
    await this._pushBatches(serialized)
    await this._reconcile()
  }

  async _pushBatches(macros) {
    for (let i = 0; i < macros.length; i += MAX_BATCH) {
      await this._api.pushWorldMacros(this._worldId, { macros: macros.slice(i, i + MAX_BATCH) })
    }
  }

  /** Tell the platform the authoritative id set so rows for macros deleted in the world are dropped. */
  async _reconcile() {
    const keepMacroIds = this._allMacros().map((m) => m.id).filter(Boolean)
    await this._api.pushWorldMacros(this._worldId, { reconcile: true, keepMacroIds })
  }
}
