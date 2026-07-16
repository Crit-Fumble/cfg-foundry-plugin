/**
 * CFG Journal Pull-Sync (#184 Phase 2)
 *
 * Carries the platform's party journal into the LIVE world. The platform never
 * touches a running world — it publishes what the world SHOULD contain and an
 * elected GM client writes it, exactly like the provision drain next door.
 *
 * Each tick the elected reporter asks the server for the entries whose doc
 * differs from what this world was last confirmed to hold, writes each one, and
 * acks. The server does the diffing, so a quiet tick is one request and no work —
 * an empty plan is the normal steady state, not an error.
 *
 * IDs ARE DERIVED, AND THAT IS LOAD-BEARING. `docData._id` comes from the
 * platform entry id (deriveFoundryEntryId server-side), so create-if-absent is an
 * exact match and a re-sync updates in place. It only holds if we pass
 * `{keepId: true}`: Foundry's default is `keepId=false`, and
 * `common/abstract/document.mjs:483` does `if (!keepId) delete data._id` — so
 * without it every tick would mint a random id, `game.journal.get()` would never
 * match, and we'd duplicate the whole journal every 30 seconds, forever.
 *
 * Direction is platform→Foundry only with last-write-wins (owner 2026-07-16): a
 * GM's in-Foundry edit to a synced entry is overwritten on the next tick. Nothing
 * flows back yet.
 *
 * Single-reporter election mirrors CharacterPullSync/ProvisionDrain: the human GM
 * with the smallest id does the work; the service-GM only when it is the sole GM.
 * A GM is required — creating documents and setting ownership are GM-only.
 *
 * All failures are non-fatal and per-entry. A failed write is acked as an error,
 * which leaves the server's baseline untouched, so the entry simply reappears in
 * the next plan and retries.
 */

'use strict'

const LOG = 'CFG Core | JournalPull |'

const PULL_MS = 30_000 // matches CharacterPullSync — "edit, then see it in Foundry"

// Matches SERVICE_GM_NATIVE_ID in cfg-core-server. Preferred reporter is a human
// GM; the service-GM only reports when it is the sole connected GM.
const SERVICE_GM_ID = 'CFGServiceGM0000'

export class JournalPullSync {
  /**
   * @param {import('../clients/api-client.js').CoreAPIClient} apiClient
   * @param {string} installationId
   */
  constructor(apiClient, installationId) {
    this._api = apiClient
    this._installationId = installationId
    this._handle = null
    this._busy = false
  }

  /** Begin pulling. Call once on ready from a GM client of a linked world. */
  start() {
    if (!this._installationId) return
    this.tick().catch((err) => console.debug?.(`${LOG} initial tick skipped:`, err?.message || err))
    this._handle = setInterval(() => {
      this.tick().catch((err) => console.debug?.(`${LOG} tick skipped:`, err?.message || err))
    }, PULL_MS)
    console.log(`${LOG} journal pull-sync started for installation ${this._installationId}`)
  }

  stop() {
    if (this._handle) {
      clearInterval(this._handle)
      this._handle = null
    }
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

  /**
   * One sweep. PUBLIC so an integration test can drive a single deterministic
   * pass instead of waiting on the 30s interval.
   */
  async tick() {
    if (this._busy) return // a slow tick must not overlap the next
    if (!this._isReporter()) return
    const worldId = game.world?.id
    if (!worldId) return

    this._busy = true
    try {
      const res = await this._api.getJournalSyncPlan(this._installationId, worldId)
      const plan = Array.isArray(res?.data) ? res.data : []
      if (plan.length === 0) return // the steady state

      console.log(`${LOG} applying ${plan.length} journal entr(y|ies)`)
      const results = []
      for (const item of plan) {
        try {
          await this._applyOne(item)
          // Echo the doc we WROTE — the server baselines against it. If the entry
          // changed platform-side between the pull and this ack, echoing keeps the
          // baseline honest about what actually landed here.
          results.push({
            journalEntryId: item.journalEntryId,
            foundryEntryId: item.foundryEntryId,
            ok: true,
            docData: item.docData,
          })
        } catch (err) {
          // One bad entry must not stop the rest; it retries next tick.
          const message = String(err?.message || err).slice(0, 1000)
          console.debug?.(`${LOG} entry ${item?.foundryEntryId} skipped:`, message)
          results.push({
            journalEntryId: item.journalEntryId,
            foundryEntryId: item.foundryEntryId,
            ok: false,
            error: message,
          })
        }
      }
      await this._api.ackJournalSync(this._installationId, worldId, results)
    } finally {
      this._busy = false
    }
  }

  /** Create-if-absent, else update in place. Keyed on the DERIVED id. */
  async _applyOne(item) {
    const { foundryEntryId, docData } = item
    if (!foundryEntryId || !docData) throw new Error('malformed plan item')

    const existing = game.journal.get(foundryEntryId)
    if (!existing) {
      // keepId is REQUIRED — see the header. Without it the derived id is dropped.
      await JournalEntry.create(docData, { keepId: true })
      return
    }

    // Pages are an embedded collection: updating them through the parent merges by
    // _id and never REMOVES one, so a page deleted on the platform would linger in
    // the world forever. Reconcile them explicitly instead.
    const { pages, ...entryFields } = docData
    await existing.update(entryFields)
    await this._reconcilePages(existing, Array.isArray(pages) ? pages : [])
  }

  /** Make the entry's pages match the platform's exactly — including deletions. */
  async _reconcilePages(entry, pages) {
    const wantedIds = new Set(pages.map((p) => p?._id).filter(Boolean))
    const haveIds = new Set(entry.pages.map((p) => p.id))

    const toCreate = pages.filter((p) => p?._id && !haveIds.has(p._id))
    const toUpdate = pages.filter((p) => p?._id && haveIds.has(p._id))
    const toDelete = [...haveIds].filter((id) => !wantedIds.has(id))

    if (toDelete.length) await entry.deleteEmbeddedDocuments('JournalEntryPage', toDelete)
    if (toUpdate.length) await entry.updateEmbeddedDocuments('JournalEntryPage', toUpdate)
    if (toCreate.length) await entry.createEmbeddedDocuments('JournalEntryPage', toCreate, { keepId: true })
  }
}
