/**
 * CFG World Pack Snapshot (dt#185) — mirror this world's GM-AUTHORED compendium packs to the
 * Core platform, so their documents are readable on the web and editable there later.
 *
 * Sibling of world-actor-snapshot.js and deliberately the same shape: single elected GM reporter,
 * full sweep on start plus a long safety-net interval, live deltas debounced, every failure
 * non-fatal. See that file for why a GM must do the pushing.
 *
 * ── What may be sent, and why the filter is not negotiable ─────────────────────────────────
 * ONLY packs whose `metadata.packageType === 'world'`. Foundry states provenance itself: a pack
 * the GM created inside this world is `world`, while packs supplied by a module (WotC books,
 * Plutonium, a system's own content) carry that module's id and belong to their publisher.
 *
 * The platform stores mirrored packs with an `origin` that ASSERTS the content is the GM's own —
 * that claim is what a future "publish/sell this as a module" path would rest on. Pushing a module
 * pack would make the claim false and put licensed content somewhere it must not be. The server
 * re-checks and refuses, but this filter is the first line: do not widen it. Licensed content is
 * meant to be surfaced read-only from the server it is installed on, never ingested.
 *
 * Compendium packs are lazily indexed in Foundry, so `getDocuments()` is awaited per pack rather
 * than read off the in-memory collection the way actors are.
 */

const LOG = 'CFG Core | WorldPacks |'
const FULL_SWEEP_MS = 15 * 60 * 1000 // safety net; deltas carry the normal case
const DELTA_DEBOUNCE_MS = 5_000
const SERVICE_GM_ID = 'cfgservicegm0001'

export class WorldPackSnapshot {
  /** @param {import('../clients/api-client.js').CoreAPIClient} apiClient */
  constructor(apiClient) {
    this._api = apiClient
    this._worldId = game.world?.id ?? null
    this._sweepHandle = null
    this._debounceHandle = null
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

    // Documents inside a pack. Foundry fires the generic document hooks with the pack as `pack`
    // in options, so filter to compendium writes and re-sweep rather than tracking per-document
    // deltas — pack edits are rare and a sweep is cheap next to the bookkeeping.
    for (const hook of ['createItem', 'updateItem', 'deleteItem', 'createActor', 'updateActor', 'deleteActor', 'createJournalEntry', 'updateJournalEntry', 'deleteJournalEntry']) {
      this._register(hook, (_doc, options) => {
        if (options?.pack) this._scheduleSweep()
      })
    }

    console.log(`${LOG} started for world ${this._worldId}`)
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

  _scheduleSweep() {
    if (!this._running) return
    if (this._debounceHandle) clearTimeout(this._debounceHandle)
    this._debounceHandle = setTimeout(() => {
      this._debounceHandle = null
      this._fullSweep().catch((err) => console.debug?.(`${LOG} delta sweep skipped:`, err?.message || err))
    }, DELTA_DEBOUNCE_MS)
  }

  /** The world's own packs. Anything supplied by a module is excluded here, not downstream. */
  _worldPacks() {
    return game.packs.filter((p) => p.metadata?.packageType === 'world')
  }

  async _fullSweep() {
    if (!this._running || !this._isReporter()) return

    const packs = []
    for (const pack of this._worldPacks()) {
      try {
        packs.push(await this._serializePack(pack))
      } catch (err) {
        // One unreadable pack must not cost the others.
        console.debug?.(`${LOG} pack ${pack?.metadata?.name} skipped:`, err?.message || err)
      }
    }
    if (packs.length === 0) return

    await this._api.pushWorldCompendiums(this._worldId, { packs })

    // Reconcile in the same pass: whatever the world no longer has should not linger on the
    // platform. Sent as ids, so a pack the GM deleted disappears rather than going stale.
    await this._api.pushWorldCompendiums(this._worldId, {
      reconcile: true,
      keepPackIds: packs.map((p) => p.name),
      keepEntryIdsByPack: Object.fromEntries(packs.map((p) => [p.name, p.entries.map((e) => e._id)])),
    })

    console.log(`${LOG} mirrored ${packs.length} world pack(s)`)
  }

  async _serializePack(pack) {
    const md = pack.metadata ?? {}
    // getDocuments() because compendium contents are lazily loaded — the index alone lacks the
    // system payload, and the whole point is verbatim Foundry documents.
    const docs = await pack.getDocuments()

    const folders = (pack.folders?.contents ?? []).map((f) => {
      const o = f.toObject()
      return { _id: o._id, name: o.name, color: o.color ?? null, sort: o.sort ?? 0, folder: o.folder ?? null }
    })

    const entries = docs.map((d) => {
      const doc = d.toObject()
      return { _id: doc._id, name: doc.name, sort: doc.sort ?? 0, folder: doc.folder ?? null, doc }
    })

    return {
      name: md.name,
      label: md.label ?? md.name,
      type: md.type ?? 'JournalEntry',
      system: md.system ?? null,
      ownership: md.ownership ?? {},
      flags: md.flags ?? {},
      // Echoed so the server can re-check rather than trust us.
      package: 'world',
      folders,
      entries,
    }
  }
}
