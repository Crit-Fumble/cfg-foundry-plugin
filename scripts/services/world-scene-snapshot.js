/**
 * World Scene snapshot (fp#48, slice 1) — mirror a Foundry world's Scenes to the platform so
 * PlayTable's Scenes panel can show the world's real scenes (and the offline world viewer can
 * render them WHILE the world is running). Sibling of world-macro-snapshot.js / world-actor-snapshot:
 * same single-writer election, debounced deltas, and full-sweep reconcile.
 *
 * The point of the PUSH (vs the platform reading the world's `scenes/` LevelDB) is that Foundry
 * holds the LevelDB LOCK while the world is loaded, so the disk read returns nothing precisely when
 * the GM is at the table. A snapshot from the live client sidesteps the lock — the mirror stays
 * fresh exactly when it matters.
 *
 * Unlike macros (tiny), a Scene can be LARGE — hundreds of walls/tiles/lights embedded. So this
 * BATCHES like the actor mirror rather than shipping the whole collection in one call. It carries
 * the full `scene.toObject()` verbatim (the codebase rule: mirror real Foundry docs, never invent a
 * parallel format); the platform's convertFoundryScene() consumes that shape for the viewer.
 *
 * GM-only and elected-single-writer: every GM client sees the same `game.scenes`, so an unelected
 * client would only duplicate writes.
 */

'use strict'

const LOG = 'CFG Core | WorldScenes |'
const FULL_SWEEP_MS = 15 * 60 * 1000
const DELTA_DEBOUNCE_MS = 5000
const SERVICE_GM_ID = 'cfgservicegm0001'
// Scenes are big; keep batches small so a push stays comfortably under the server body limit.
const MAX_BATCH = 10

export class WorldSceneSnapshot {
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

    this._register('createScene', (scene) => this._onChanged(scene))
    this._register('updateScene', (scene) => this._onChanged(scene))
    this._register('deleteScene', () => this._onDeleted())

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

  _onChanged(scene) {
    if (!this._running || !scene?.id) return
    this._dirty.add(scene.id)
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

  /** The wire shape for one scene: the full source object. The platform reads `name`, `active`,
   *  `thumb`, `width`/`height`, `ownership`, `folder` off it and feeds the whole doc to
   *  convertFoundryScene — sending the full doc keeps us honest ("mirror real Foundry docs") and
   *  future-proof against new fields. */
  _serialize(scene) {
    try {
      return scene.toObject()
    } catch {
      return null
    }
  }

  _allScenes() {
    return game.scenes?.contents ?? []
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

    const scenes = ids.map((id) => game.scenes.get(id)).filter(Boolean).map((s) => this._serialize(s)).filter(Boolean)
    if (scenes.length > 0) await this._pushBatches(scenes)
    if (needsReconcile) await this._reconcile()
  }

  async _fullSweep() {
    if (!this._isReporter()) return
    const serialized = this._allScenes().map((s) => this._serialize(s)).filter(Boolean)
    await this._pushBatches(serialized)
    await this._reconcile()
  }

  async _pushBatches(scenes) {
    for (let i = 0; i < scenes.length; i += MAX_BATCH) {
      await this._api.pushWorldScenes(this._worldId, { scenes: scenes.slice(i, i + MAX_BATCH) })
    }
  }

  /** Tell the platform the authoritative id set so rows for scenes deleted in the world are dropped. */
  async _reconcile() {
    const keepSceneIds = this._allScenes().map((s) => s.id).filter(Boolean)
    await this._api.pushWorldScenes(this._worldId, { reconcile: true, keepSceneIds })
  }
}
