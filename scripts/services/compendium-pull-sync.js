/**
 * CFG Compendium Pull-Sync (dt#185 slice 3) — the Core→Foundry write-back for world compendium
 * packs. Sibling of character-pull-sync.js.
 *
 * When a GM edits a mirrored entry in PlayTable, the server stamps `platformEditedAt` on that row.
 * That claim does two things: it stops the next mirror sweep from overwriting the edit with the
 * world's stale copy, and it queues the edit here. The platform never touches the live VTT — a
 * connected GM client has to carry it across.
 *
 * Each tick the elected reporter pulls the pending set, applies each entry to the live pack, and
 * reports what landed so the server can release the claim. Anything not reported stays pending for
 * the next tick, so a partial apply loses nothing.
 *
 * ── Why two apply paths ─────────────────────────────────────────────────────────────────────
 * `Document#update()` CANNOT change a document's `type`, and — verified against a live v14 world —
 * it does NOT throw when asked to: the promise resolves and the type is silently unchanged. The
 * headline use case for this feature is retooling a copied CLASS into a SUBCLASS, so an
 * update()-only implementation would appear to work while quietly discarding exactly the change
 * the GM cared about.
 *
 * So a type change is applied as delete + create with `keepId: true`, which preserves the `_id`
 * (also verified live) and therefore keeps the platform row, its slug, and any links pointing at
 * it intact. Everything else takes the cheap update() path.
 *
 * Failures are non-fatal per entry: one bad document must not strand the rest of the queue.
 */

import { applyDesiredDocument, DocumentHealthError } from './document-apply.js'
import { probeDocumentHealth } from './document-health-probe.js'

const LOG = 'CFG Core | CompendiumPull |'
const TICK_MS = 60_000
const SERVICE_GM_ID = 'cfgservicegm0001'

export class CompendiumPullSync {
  /** @param {import('../clients/api-client.js').CoreAPIClient} apiClient */
  constructor(apiClient) {
    this._api = apiClient
    this._worldId = game.world?.id ?? null
    this._handle = null
    this._running = false
    this._busy = false
  }

  start() {
    if (!this._worldId) return
    this._running = true
    this._tick().catch((err) => console.debug?.(`${LOG} initial tick skipped:`, err?.message || err))
    this._handle = setInterval(() => {
      this._tick().catch((err) => console.debug?.(`${LOG} tick skipped:`, err?.message || err))
    }, TICK_MS)
    console.log(`${LOG} write-back started for world ${this._worldId}`)
  }

  stop() {
    this._running = false
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

  async _tick() {
    if (!this._running || this._busy || !this._isReporter()) return
    this._busy = true
    try {
      const pending = await this._api.listPendingWorldCompendiums(this._worldId)
      const packs = pending?.packs ?? []
      if (packs.length === 0) return

      const applied = []
      for (const p of packs) {
        const ids = await this._applyPack(p)
        if (ids.length) applied.push({ packName: p.name, foundryEntryIds: ids })
      }
      if (applied.length) {
        const res = await this._api.drainWorldCompendiums(this._worldId, { applied })
        const n = applied.reduce((a, x) => a + x.foundryEntryIds.length, 0)
        console.log(`${LOG} applied ${n} entr${n === 1 ? 'y' : 'ies'} to the world (drained ${res?.drained ?? 0})`)
      }
    } finally {
      this._busy = false
    }
  }

  /** Apply one pack's pending entries; returns the ids that actually landed. */
  async _applyPack(payload) {
    const pack = game.packs.get(`world.${payload.name}`)
    // Only world packs are ever mirrored, so a missing pack means it was deleted or renamed in the
    // world — leave those pending rather than inventing a pack to hold them.
    if (!pack || pack.metadata?.packageType !== 'world') {
      console.debug?.(`${LOG} pack ${payload.name} not present — leaving its edits pending`)
      return []
    }

    const applied = []
    for (const entry of payload.entries ?? []) {
      try {
        if (await this._applyEntry(pack, entry)) applied.push(entry.foundryEntryId)
      } catch (err) {
        if (err instanceof DocumentHealthError) {
          // Louder than a transient skip: this entry is stuck until the GM fixes it, and applying
          // it would have crashed the world. Surfaced at warn so it is visible in logs; the entry
          // stays pending (not reported as applied) so nothing is lost. Reporting the reason back
          // to the platform editor is the follow-up (dt#213 needs a status channel).
          console.warn(`${LOG} entry ${entry.foundryEntryId} would crash Foundry — not applied:`, err.message)
        } else {
          console.debug?.(`${LOG} entry ${entry.foundryEntryId} skipped:`, err?.message || err)
        }
      }
    }
    return applied
  }

  async _applyEntry(pack, entry) {
    const live = await pack.getDocument(entry.foundryEntryId).catch(() => null)
    const desired = { ...(entry.doc ?? {}), _id: entry.foundryEntryId }
    const DocClass = CONFIG[pack.metadata.type]?.documentClass
    if (!DocClass) return false

    // Absent from the world (deleted there, or platform-authored): recreate it so the GM's work
    // is not silently dropped. The health probe still guards it — a create that would crash on
    // prep must not land either. keepId keeps the platform row pointing at the same document.
    if (!live) {
      const health = probeDocumentHealth(DocClass, desired)
      if (!health.ok) throw new DocumentHealthError(health.reason)
      const created = await DocClass.create(desired, { pack: pack.collection, keepId: true })
      return !!created
    }

    // Existing document: the shared apply handles the probe, the type-change delete+recreate, and
    // the deletion markers — the same logic the in-Foundry JSON editor uses, so the two cannot
    // drift on this data-integrity-critical path. Deliberately NOT gated on the server's
    // `entry.typeChanged` flag: it is derived from the held doc rather than the live document, so
    // it is always false and once made this whole branch unreachable (a class silently stayed a
    // class in the world). The live document is the only trustworthy source of the current type.
    await applyDesiredDocument(live, DocClass, desired, { collection: pack.collection })
    return true
  }
}
