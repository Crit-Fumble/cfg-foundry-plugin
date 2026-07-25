/**
 * CFG generic document pull-sync (dt#244) — the GM-side half of platform→Foundry sync.
 *
 * The write path every entity needs, extracted from the actor sync (fp#46/fp#49) so Macro,
 * Scene, Journal and the rest are a CONFIG object rather than another 250 lines of the same
 * Foundry footguns. The server publishes a desired-state plan; this writes it and acks. The
 * platform never touches a running world.
 *
 * ── THE FOUNDRY FACTS THIS ENCODES, all measured against a real world ────────────────
 *
 *  1. `{keepId: true}` IS MANDATORY on create. Foundry's default is false and
 *     `common/abstract/document.mjs:483` does `if (!keepId) delete data._id` — without it
 *     we mint a random id, the lookup never matches, and we duplicate every document in
 *     the world every 30 seconds, forever.
 *
 *  2. `update()` CANNOT change `type`. It resolves and silently keeps the old one, so a
 *     type change must be delete + create with keepId.
 *
 *  3. EMBEDDED COLLECTIONS merge by `_id` through a parent update and are NEVER removed by
 *     it. Items, effects, journal pages, scene tokens all need explicit reconciliation.
 *
 *  4. DELETION MARKERS come from the server's `removedPaths` and are merged NESTED into the
 *     payload — never derived here by diffing the live document. Diffing `live.toObject()`
 *     asks Foundry to delete every field the platform doesn't model (`_stats`,
 *     `prototypeToken`, most of a DataModel) and the whole update becomes a SILENT no-op.
 *     Markers are also type-sensitive: they work on `flags`, throw on `Actor.img`, and are
 *     silently ignored under a DataModel-backed `system`. The SERVER decides which paths
 *     are eligible, per document type, from measurement.
 *
 *  5. `everPushed` distinguishes "not created yet" from "the GM deleted it": absent +
 *     never-pushed → create; absent + already-pushed → report `world_deleted` so the server
 *     parks the row instead of resurrecting the document on every tick.
 *
 * Single-reporter election: the human GM with the smallest id does the work; the service-GM
 * only when it is the sole connected GM. A GM is required — creating documents and setting
 * ownership are GM-only.
 *
 * All failures are non-fatal and per-document. A failed write is acked as an error, which
 * leaves the server's baseline untouched, so the document reappears in the next plan.
 */

'use strict'

import { probeDocumentHealth } from './document-health-probe.js'
import { DocumentHealthError } from './document-apply.js'

const PULL_MS = 30_000 // "edit, then see it in Foundry"

// Matches SERVICE_GM_NATIVE_ID in cfg-core-server. Preferred reporter is a human GM; the
// service-GM only reports when it is the sole connected GM.
const SERVICE_GM_ID = 'CFGServiceGM0000'

/** Thrown to ack a refusal with a machine-readable code the server branches on. */
export class ApplyRefusal extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ApplyRefusal'
    this.code = code
  }
}

/**
 * Merge the server's dotted `removedPaths` into the update payload as Foundry `-=` markers.
 *
 * Foundry marks a deletion by prefixing the FINAL path segment with `-=`, so
 * `flags.playtable.luck` becomes `flags: { playtable: { '-=luck': null } }`.
 *
 * MARKERS ARE NESTED INTO THE PAYLOAD, NOT FLAT DOTTED KEYS. Verified against Foundry
 * v14.361: a flat `flags.playtable.-=luck` sent ALONGSIDE a nested `flags` object is
 * silently dropped — the two collide when Foundry expands the payload and the nested object
 * wins. One coherent tree is the only form that applies.
 *
 * Returns a copy; the caller's `fields` is never mutated.
 */
export function withRemovals(fields, removedPaths) {
  if (!Array.isArray(removedPaths) || removedPaths.length === 0) return fields

  const out = { ...fields }
  for (const path of removedPaths) {
    if (typeof path !== 'string' || !path) continue
    const segments = path.split('.')
    const leaf = segments.pop()
    if (!leaf) continue

    let cursor = out
    let ok = true
    for (const segment of segments) {
      const next = cursor[segment]
      if (next !== undefined && (typeof next !== 'object' || next === null || Array.isArray(next))) {
        ok = false // the platform put a non-object here; a marker under it is meaningless
        break
      }
      cursor[segment] = next === undefined ? {} : { ...next }
      cursor = cursor[segment]
    }
    if (ok) cursor[`-=${leaf}`] = null
  }
  return out
}

/**
 * @typedef {object} DocSyncConfig
 * @property {string} label                    log prefix, e.g. 'ActorPull'
 * @property {string} noun                     singular noun for log lines, e.g. 'actor'
 * @property {() => object} collection         the live world collection, e.g. `() => game.actors`
 * @property {() => Function} DocClass         the document class, e.g. `() => Actor`
 * @property {() => Function} probeClass       class to health-probe against, e.g. `() => CONFIG.Actor.documentClass`
 * @property {boolean} checkSystem             refuse a doc built for another game system
 * @property {string} platformIdKey            plan/ack key for the platform id, e.g. 'characterId'
 * @property {string} foundryIdKey             plan/ack key for the world id, e.g. 'foundryActorId'
 * @property {(api, inst, world, system) => Promise<any>} getPlan
 * @property {(api, inst, world, system, results) => Promise<any>} ack
 * @property {Array<{name: string, field: string, of: (live: any) => any[]}>} [embedded]
 *           embedded collections to reconcile, e.g. Item/`items`, ActiveEffect/`effects`
 */

export class DocPullSync {
  /**
   * @param {import('../clients/api-client.js').CoreAPIClient} apiClient
   * @param {string} installationId
   * @param {DocSyncConfig} config
   */
  constructor(apiClient, installationId, config) {
    this._api = apiClient
    this._installationId = installationId
    this._cfg = config
    this._log = `CFG Core | ${config.label} |`
    this._handle = null
    this._busy = false
  }

  /** Begin pulling. Call once on ready from a GM client of a linked world. */
  start() {
    if (!this._installationId) return
    this.tick().catch((err) => console.debug?.(`${this._log} initial tick skipped:`, err?.message || err))
    this._handle = setInterval(() => {
      this.tick().catch((err) => console.debug?.(`${this._log} tick skipped:`, err?.message || err))
    }, PULL_MS)
    console.log(`${this._log} ${this._cfg.noun} pull-sync started for installation ${this._installationId}`)
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
   * One sweep. PUBLIC so an integration test can drive a single deterministic pass instead
   * of waiting on the 30s interval.
   */
  async tick() {
    if (this._busy) return // a slow tick must not overlap the next
    if (!this._isReporter()) return
    const worldId = game.world?.id
    if (!worldId) return
    const systemId = game.system?.id
    if (!systemId) return

    const { platformIdKey, foundryIdKey } = this._cfg

    this._busy = true
    try {
      const res = await this._cfg.getPlan(this._api, this._installationId, worldId, systemId)
      const plan = Array.isArray(res?.data) ? res.data : []
      if (plan.length === 0) return // the steady state

      console.log(`${this._log} applying ${plan.length} ${this._cfg.noun}(s)`)
      const results = []
      for (const item of plan) {
        const ids = { [platformIdKey]: item[platformIdKey] ?? null, [foundryIdKey]: item[foundryIdKey] }
        try {
          await this._applyOne(item)
          // Echo the doc we WROTE — the server baselines against it. If the platform record
          // changed between the pull and this ack, echoing keeps the baseline honest about
          // what actually landed here.
          results.push({ ...ids, ok: true, docData: item.docData, ...(item.claimedAt ? { claimedAt: item.claimedAt } : {}) })
        } catch (err) {
          // One bad document must not stop the rest; it retries next tick (except
          // world_deleted, which the server parks).
          const message = String(err?.message || err).slice(0, 1000)
          console.debug?.(`${this._log} ${this._cfg.noun} ${item?.[foundryIdKey]} skipped:`, message)
          results.push({ ...ids, ok: false, error: message, ...(err?.code ? { code: err.code } : {}) })
        }
      }
      await this._cfg.ack(this._api, this._installationId, worldId, systemId, results)
    } finally {
      this._busy = false
    }
  }

  /** Create-if-absent, else update in place. Keyed on the server-assigned id. */
  async _applyOne(item) {
    const cfg = this._cfg
    const foundryDocId = item[cfg.foundryIdKey]
    const { docData, everPushed, systemId } = item
    if (!foundryDocId || !docData) throw new Error('malformed plan item')

    // The world is the authority on its own system — refuse before touching anything.
    if (cfg.checkSystem && systemId && game.system?.id && systemId !== game.system.id) {
      throw new ApplyRefusal('system_mismatch', `${cfg.noun} is for ${systemId}, world runs ${game.system.id}`)
    }

    const live = cfg.collection().get(foundryDocId)

    if (!live) {
      if (everPushed) {
        // We wrote this document before and it is gone: the GM deleted it. Re-creating it
        // every tick would make the world un-editable.
        throw new ApplyRefusal('world_deleted', `${cfg.noun} was deleted in this world`)
      }
      await this._create(docData)
      return
    }

    // For some document classes `update()` resolves and silently KEEPS the old type, so a
    // type change must be delete + create (the rule document-apply.js encodes for
    // compendium docs). For others it just works. Which is which is MEASURED per type —
    // Actor needs the recreate, Macro does not — and recreating unnecessarily is real
    // churn: the document briefly stops existing, and anything holding a live reference
    // to it drops.
    const typeIsImmutable = cfg.typeIsImmutable !== false
    if (typeIsImmutable && docData.type && live.type && docData.type !== live.type) {
      await this._probe(docData)
      await live.delete()
      await this._create(docData, { probed: true })
      return
    }

    const embedded = cfg.embedded ?? []
    const fields = { ...docData }
    delete fields._id
    for (const e of embedded) delete fields[e.field]

    // Deletion markers come from the SERVER's removedPaths — never from diffing the live
    // document. See the header, fact 4.
    await live.update(withRemovals(fields, item.removedPaths))

    for (const e of embedded) {
      await this._reconcileEmbedded(live, e.name, e.of(live), docData[e.field])
    }
  }

  /** Refuse a doc that would crash Foundry's preparation BEFORE writing it (dt#213). */
  async _probe(docData) {
    const health = probeDocumentHealth(this._cfg.probeClass(), docData)
    if (!health.ok) throw new DocumentHealthError(health.reason)
  }

  async _create(docData, { probed = false } = {}) {
    if (!probed) await this._probe(docData)
    // keepId is REQUIRED — see the header, fact 1.
    await this._cfg.DocClass().create(docData, { keepId: true })
  }

  /** Make an embedded collection match the platform's exactly — including deletions. */
  async _reconcileEmbedded(parent, docName, liveCollection, desired) {
    if (!Array.isArray(desired)) return // absent means "not managed", not "delete all"

    const wantedIds = new Set(desired.map((d) => d?._id).filter(Boolean))
    const haveIds = new Set((liveCollection ?? []).map((d) => d.id))

    const toCreate = desired.filter((d) => d?._id && !haveIds.has(d._id))
    const toUpdate = desired.filter((d) => d?._id && haveIds.has(d._id))
    const toDelete = [...haveIds].filter((id) => !wantedIds.has(id))

    if (toDelete.length) await parent.deleteEmbeddedDocuments(docName, toDelete)
    if (toUpdate.length) await parent.updateEmbeddedDocuments(docName, toUpdate)
    if (toCreate.length) await parent.createEmbeddedDocuments(docName, toCreate, { keepId: true })
  }
}
