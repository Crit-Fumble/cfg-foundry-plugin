/**
 * Apply a desired document state to a live Foundry document — the shared core of the compendium
 * write-back (dt#185) and the in-Foundry JSON editor (dt#212 parity).
 *
 * Both callers face the identical, subtle set of Foundry facts, and getting any of them wrong
 * corrupts data. Keeping the logic in one place is deliberate: a second copy that drifted on the
 * deletion markers or the type-change handling would be a silent data-loss bug, so this is one
 * authority rather than the two the rule-of-three would otherwise allow.
 *
 *   1. `Document#update()` CANNOT change `type` — it resolves and silently keeps the old type. A
 *      type change must be delete + create with `keepId: true`.
 *   2. `update()` deep-MERGES, so a removed key is merely absent and Foundry keeps its old value.
 *      Removals need Foundry's explicit `-=key` deletion markers.
 *   3. A document that will crash Foundry's preparation (a HitPoints advancement on a subclass with
 *      no hit die) must be refused BEFORE anything destructive runs — see document-health-probe.
 */

'use strict'

import { probeDocumentHealth } from './document-health-probe.js'

/** A document that would crash Foundry's preparation (dt#213). Carries the reason so callers can
 *  surface WHY, distinct from a transient world-rejected-it failure. */
export class DocumentHealthError extends Error {
  constructor(reason) {
    super(reason)
    this.name = 'DocumentHealthError'
  }
}

/**
 * `_id` and `type` are NEVER marked for deletion. Both are identity rather than content, and `type`
 * in particular is deliberately stripped from the update payload — so a naive diff concludes the GM
 * removed it and emits `-=type`, asking Foundry to delete the field that decides what the document
 * IS. A test caught exactly that; it would have been far worse than the merge bug this fixes.
 */
const NEVER_DELETE = new Set(['_id', 'type'])

/**
 * Augment a desired-state payload with Foundry's `-=` deletion markers so `update()` actually
 * REMOVES keys the desired state dropped, instead of merge-keeping the old values.
 *
 * Only PLAIN objects are recursed. Arrays are replaced wholesale by `update()` already, so
 * descending into them would emit meaningless index deletions; a null/primitive on either side ends
 * the walk because there is no key set to compare.
 */
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

/**
 * Apply `desired` to the existing `live` document, choosing update vs delete+recreate as the type
 * change requires, and refusing anything that would crash Foundry.
 *
 * @param {object}   live       the live Foundry document being replaced
 * @param {Function} DocClass   e.g. `CONFIG.Item.documentClass`
 * @param {object}   desired    the full desired document data (carries `_id`)
 * @param {object}   [opts]
 * @param {string|null} [opts.collection]  pack collection id when the document lives in a compendium
 * @returns {Promise<object>} the resulting live document
 * @throws {DocumentHealthError} when the desired document would fail Foundry's preparation
 */
export async function applyDesiredDocument(live, DocClass, desired, { collection = null } = {}) {
  const health = probeDocumentHealth(DocClass, desired)
  if (!health.ok) throw new DocumentHealthError(health.reason)

  const createOpts = collection ? { pack: collection, keepId: true } : { keepId: true }

  // Type change → delete + recreate; update() would resolve without applying it (fact 1).
  if (desired.type && desired.type !== live.type) {
    await live.delete()
    return DocClass.create(desired, createOpts)
  }

  // Same type → update. `type` and `_id` are dropped from the diff — `type` is a silent no-op on
  // update (fact 1) and `_id` is the document's own identity, not a field to write — then deletion
  // markers are added so removals actually take (fact 2).
  const { type: _type, _id: _id, ...rest } = desired
  await live.update(withDeletions(live.toObject(), rest))
  return live
}
