/**
 * CFG Actor Pull-Sync (fp#46)
 *
 * Carries a platform character into the LIVE world — including CREATING it, which is the
 * whole point. Its predecessor, CharacterPullSync, could only ever UPDATE an actor that
 * already existed: `Actor.create` appeared nowhere in this plugin, and two gates bailed
 * silently on an absent actor (`if (!game.actors.get(id)) continue`, and `if (!actor)
 * return // actor not in this world (yet)`). That `(yet)` never came, so a character
 * created in PlayTable was invisible at the table forever.
 *
 * Shape is the journal sync's (#184), not the old character sync's: the server publishes
 * a desired-state PLAN and this writes it and acks. The platform never touches a running
 * world. A quiet tick is one request and no work — an empty plan is the steady state.
 *
 * KEEPID IS LOAD-BEARING. `docData._id` is assigned server-side (adopted from the sheet
 * or derived from the character id), so create-if-absent is an exact match and a re-sync
 * updates in place. That only holds with `{keepId: true}`: Foundry's default is false and
 * `common/abstract/document.mjs:483` does `if (!keepId) delete data._id` — without it we
 * would mint a random id, `game.actors.get()` would never match, and we would duplicate
 * every actor in the world every 30 seconds, forever.
 *
 * TWO THINGS THE JOURNAL SYNC DOES NOT HAVE TO DO:
 *   - Refuse a foreign system. An Actor carries a `system` block that fails validation in
 *     a world running a different system; JournalEntry has none. A mismatch is acked as
 *     an error, never retried into a console throw-loop.
 *   - Distinguish "not created yet" from "the GM deleted it". `everPushed` on the plan
 *     item is that distinction: absent + never-pushed → create; absent + already-pushed →
 *     report `world_deleted` so the server parks the row instead of resurrecting the
 *     actor on every tick.
 *
 * Direction is platform→Foundry. A GM's in-world edit is not clobbered blindly: the
 * server's mirror compares Foundry's own `_stats.modifiedTime` against the platform
 * sheet's clock and only plans a push when the platform genuinely moved last.
 *
 * Single-reporter election mirrors JournalPullSync/ProvisionDrain: the human GM with the
 * smallest id does the work; the service-GM only when it is the sole connected GM. A GM
 * is required — creating documents and setting ownership are GM-only.
 *
 * All failures are non-fatal and per-actor. A failed write is acked as an error, which
 * leaves the server's baseline untouched, so the character reappears in the next plan.
 */

'use strict'

import { probeDocumentHealth } from './document-health-probe.js'
import { DocumentHealthError } from './document-apply.js'

const LOG = 'CFG Core | ActorPull |'

const PULL_MS = 30_000 // matches JournalPullSync — "edit, then see it in Foundry"

// Matches SERVICE_GM_NATIVE_ID in cfg-core-server. Preferred reporter is a human GM; the
// service-GM only reports when it is the sole connected GM.
const SERVICE_GM_ID = 'CFGServiceGM0000'

/** Thrown to ack a refusal with a machine-readable code the server branches on. */
class ApplyRefusal extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ApplyRefusal'
    this.code = code
  }
}

/**
 * Merge the server's dotted `removedPaths` into the update payload as Foundry's `-=`
 * deletion markers (fp#49).
 *
 * Foundry marks a deletion by prefixing the FINAL path segment with `-=`, so
 * `system.details.biography` becomes `system: { details: { '-=biography': null } }`.
 *
 * MARKERS ARE NESTED INTO THE PAYLOAD, NOT SENT AS FLAT DOTTED KEYS. Verified against
 * Foundry v14.361: a flat `system.details.-=biography` key sent ALONGSIDE a nested
 * `system` object is silently dropped — the two collide when Foundry expands the payload
 * and the nested object wins. One coherent tree is the only form that applies.
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

    // Walk down, cloning as we go so we never mutate a shared sub-object.
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

export class ActorPullSync {
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
    console.log(`${LOG} actor pull-sync started for installation ${this._installationId}`)
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
   * One sweep. PUBLIC so an integration test can drive a single deterministic pass
   * instead of waiting on the 30s interval.
   */
  async tick() {
    if (this._busy) return // a slow tick must not overlap the next
    if (!this._isReporter()) return
    const worldId = game.world?.id
    if (!worldId) return
    const systemId = game.system?.id
    if (!systemId) return

    this._busy = true
    try {
      const res = await this._api.getActorSyncPlan(this._installationId, worldId, systemId)
      const plan = Array.isArray(res?.data) ? res.data : []
      if (plan.length === 0) return // the steady state

      console.log(`${LOG} applying ${plan.length} actor(s)`)
      const results = []
      for (const item of plan) {
        try {
          await this._applyOne(item)
          // Echo the doc we WROTE — the server baselines against it. If the sheet changed
          // platform-side between the pull and this ack, echoing keeps the baseline
          // honest about what actually landed here.
          results.push({
            characterId: item.characterId ?? null,
            foundryActorId: item.foundryActorId,
            ok: true,
            docData: item.docData,
            ...(item.claimedAt ? { claimedAt: item.claimedAt } : {}),
          })
        } catch (err) {
          // One bad actor must not stop the rest; it retries next tick (except
          // world_deleted, which the server parks).
          const message = String(err?.message || err).slice(0, 1000)
          console.debug?.(`${LOG} actor ${item?.foundryActorId} skipped:`, message)
          results.push({
            characterId: item.characterId ?? null,
            foundryActorId: item.foundryActorId,
            ok: false,
            error: message,
            ...(err?.code ? { code: err.code } : {}),
          })
        }
      }
      await this._api.ackActorSync(this._installationId, worldId, systemId, results)
    } finally {
      this._busy = false
    }
  }

  /** Create-if-absent, else update in place. Keyed on the server-assigned id. */
  async _applyOne(item) {
    const { foundryActorId, docData, everPushed, systemId } = item
    if (!foundryActorId || !docData) throw new Error('malformed plan item')

    // The world is the authority on its own system — refuse before touching anything.
    if (systemId && game.system?.id && systemId !== game.system.id) {
      throw new ApplyRefusal('system_mismatch', `actor is for ${systemId}, world runs ${game.system.id}`)
    }

    const live = game.actors.get(foundryActorId)

    if (!live) {
      if (everPushed) {
        // We wrote this actor before and it is gone: the GM deleted it. Re-creating it
        // every tick would make the world un-editable.
        throw new ApplyRefusal('world_deleted', 'actor was deleted in this world')
      }
      await this._create(docData)
      return
    }

    // `update()` resolves and silently KEEPS the old type, so a type change has to be a
    // delete + create (same rule document-apply.js encodes for compendium docs).
    if (docData.type && live.type && docData.type !== live.type) {
      await this._probe(docData)
      await live.delete()
      await this._create(docData, { probed: true })
      return
    }

    // Embedded collections merge by _id through a parent update and are never REMOVED by
    // it, so they are reconciled explicitly — exactly like journal pages.
    const { items, effects, _id: _ignoredId, ...fields } = docData

    // Deletion markers come from the SERVER's `removedPaths`, never from diffing the live
    // document (fp#49). This is deliberate and load-bearing.
    //
    // `document-apply.js`'s `withDeletions` is right for the compendium write-back and
    // the JSON editor, where the desired state is a COMPLETE Foundry document. An actor
    // doc from the platform is not — it carries what the sheet models and nothing else.
    // Diffing it against `live.toObject()` asks Foundry to delete everything we don't
    // represent (`_stats`, `prototypeToken`, most of a system's DataModel), and on
    // dnd5e 5.3.3 / Foundry v14.361 that makes the ENTIRE update a silent no-op: the
    // promise resolves, nothing throws, and the change we wanted never lands. It would
    // be data loss even if it worked.
    //
    // `removedPaths` is computed against the server's own `lastPushedData`, so it can
    // only ever name fields WE previously wrote. A field the platform never modelled was
    // never in that baseline and therefore cannot be proposed for deletion.
    await live.update(withRemovals(fields, item.removedPaths))
    await this._reconcileEmbedded(live, 'Item', live.items, items)
    await this._reconcileEmbedded(live, 'ActiveEffect', live.effects, effects)
  }

  /** Refuse a doc that would crash Foundry's preparation BEFORE writing it (dt#213). */
  async _probe(docData) {
    const health = probeDocumentHealth(CONFIG?.Actor?.documentClass, docData)
    if (!health.ok) throw new DocumentHealthError(health.reason)
  }

  async _create(docData, { probed = false } = {}) {
    if (!probed) await this._probe(docData)
    // keepId is REQUIRED — see the header. Without it the assigned id is dropped.
    await Actor.create(docData, { keepId: true })
  }

  /** Make an embedded collection match the platform's exactly — including deletions. */
  async _reconcileEmbedded(actor, docName, liveCollection, desired) {
    if (!Array.isArray(desired)) return // absent means "not managed", not "delete all"

    const wantedIds = new Set(desired.map((d) => d?._id).filter(Boolean))
    const haveIds = new Set((liveCollection ?? []).map((d) => d.id))

    const toCreate = desired.filter((d) => d?._id && !haveIds.has(d._id))
    const toUpdate = desired.filter((d) => d?._id && haveIds.has(d._id))
    const toDelete = [...haveIds].filter((id) => !wantedIds.has(id))

    if (toDelete.length) await actor.deleteEmbeddedDocuments(docName, toDelete)
    if (toUpdate.length) await actor.updateEmbeddedDocuments(docName, toUpdate)
    if (toCreate.length) await actor.createEmbeddedDocuments(docName, toCreate, { keepId: true })
  }
}
