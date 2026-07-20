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

import { probeDocumentHealth } from './document-health-probe.js'

/** A pending entry that would crash Foundry's document preparation (dt#213). Carries the reason so
 *  the apply loop can log WHY, distinct from a transient world-rejected-it skip. */
class DocumentHealthError extends Error {
  constructor(reason) {
    super(reason)
    this.name = 'DocumentHealthError'
  }
}

/**
 * Augment a desired-state payload with Foundry's `-=` deletion markers.
 *
 * `Document#update()` deep-merges, so a key the GM removed on the platform is merely ABSENT from
 * the payload and Foundry keeps its old value. The write-back could therefore add and change but
 * never remove — verified live: deleting a HitPoints advancement from a subclass wrote back the
 * sibling edits and silently kept the advancement, leaving a document whose sheet crashed on
 * render because that advancement reads a field the subclass no longer has.
 *
 * Walks `live` against `next` and returns a copy of `next` carrying `-=<key>: null` for every key
 * that exists in the live document but not the desired one.
 *
 * Only PLAIN objects are recursed. Arrays are replaced wholesale by `update()` already, so
 * descending into them would emit meaningless index deletions; and a null/primitive on either side
 * ends the walk because there is no key set to compare.
 *
 * `_id` and `type` are NEVER deleted. Both are identity rather than content, and `type` in
 * particular is deliberately stripped from the payload by the caller — so a naive diff concludes
 * the GM removed it and emits `-=type`, asking Foundry to delete the field that decides what the
 * document IS. A test caught exactly that; it would have been far worse than the merge bug this
 * function exists to fix.
 */
const NEVER_DELETE = new Set(['_id', 'type'])

export function withDeletions(live, next) {
  if (!isPlainObject(live) || !isPlainObject(next)) return next

  const out = {}
  for (const [key, nextValue] of Object.entries(next)) {
    const liveValue = live[key]
    out[key] = isPlainObject(liveValue) && isPlainObject(nextValue) ? withDeletions(liveValue, nextValue) : nextValue
  }

  for (const key of Object.keys(live)) {
    if (NEVER_DELETE.has(key)) continue
    if (Object.prototype.hasOwnProperty.call(next, key)) continue
    out[`-=${key}`] = null
  }

  return out
}

/** A data object, as opposed to an array, null, or a class instance Foundry would rather we left alone. */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

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
    const doc = entry.doc ?? {}
    const DocClass = CONFIG[pack.metadata.type]?.documentClass
    if (!DocClass) return false

    // dt#213 — refuse to apply a document that will crash Foundry's preparation. The headline case
    // is a class retooled into a subclass that KEEPS a HitPoints advancement reading the `hd` the
    // subclass discards: schema-valid, and it throws on render. This matters most for the
    // type-change path below, which is delete + recreate — without this guard a crashing recreate
    // would leave the world with the document DELETED and nothing in its place. Probing up front
    // means one code path protects every branch, and nothing destructive runs on a doomed doc.
    const health = probeDocumentHealth(DocClass, { ...doc, _id: entry.foundryEntryId })
    if (!health.ok) throw new DocumentHealthError(health.reason)

    // Absent from the world (deleted there, or platform-authored): recreate it so the GM's work
    // is not silently dropped. keepId keeps the platform row pointing at the same document.
    if (!live) {
      const created = await DocClass.create({ ...doc, _id: entry.foundryEntryId }, { pack: pack.collection, keepId: true })
      return !!created
    }

    // Type change → delete + recreate. update() would resolve without applying it.
    //
    // Deliberately NOT gated on the server's `entry.typeChanged`. That flag is computed as
    // `doc.type !== row.docType`, but `docType` is denormalized FROM the held doc by the same
    // write that stores it — the two are copies of one value, so the flag is always false and this
    // branch was unreachable. A class retooled into a subclass updated on the platform and
    // silently stayed a class in the world, which is the precise failure the flag was added to
    // prevent. The live document is the only thing that actually knows the world's current type,
    // and the client is the only place holding it — so decide here and ignore the hint.
    if (doc.type && doc.type !== live.type) {
      await live.delete()
      const created = await DocClass.create({ ...doc, _id: entry.foundryEntryId }, { pack: pack.collection, keepId: true })
      return !!created
    }

    // `type` is stripped rather than sent-and-ignored, so the no-op is explicit here instead of
    // silent inside Foundry.
    const { type: _ignored, ...rest } = doc

    // The platform doc is the DESIRED STATE, but `update()` deep-MERGES: a key the GM removed is
    // simply absent from the payload, and Foundry keeps the old value. So deletions never reached
    // the world at all — verified live, removing a HitPoints advancement from a subclass wrote
    // back the sibling field edits and silently kept the advancement, leaving a document whose
    // sheet then crashed. Foundry's own mechanism for "remove this key" is the `-=` prefix, so
    // diff the live document against the desired one and say so explicitly.
    await live.update(withDeletions(live.toObject(), rest))
    return true
  }
}
