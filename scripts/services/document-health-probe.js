/**
 * Document health probe (dt#213) — will this document CRASH when Foundry prepares it?
 *
 * ── The failure it catches ──────────────────────────────────────────────────────────────────────
 * dt#212 warns about `system` fields the target type will DISCARD. It cannot catch the other half:
 * a field the document KEEPS depending on one it just lost. The headline case, hit 4-for-4 on real
 * conversions: retooling a class into a subclass drops `hd`, but the RETAINED `advancement` array
 * still holds a HitPoints entry, and HitPoints reads `system.hd.denomination`. The document is
 * schema-valid, passes every field-level check, and throws on render:
 *
 *   Cannot read properties of undefined (reading 'denomination')
 *     at get hitDie (hit-points.mjs) → sortingValueForLevel → _prepareAdvancement
 *
 * ── Why it must actually RUN the document, not inspect it ────────────────────────────────────────
 * Verified against live dnd5e 5.3.3 (see docs/notes):
 *   - `new DocClass(data)` does NOT throw — `_safePrepareData` swallows the prep error and routes
 *     it to Hooks.onError, which is why the corruption is silent.
 *   - `updateSource({})` does NOT throw either.
 *   - The crash surfaces only when the SHEET calls each advancement's level-preview methods
 *     (`sortingValueForLevel` and friends). So the probe constructs the document and calls exactly
 *     those, catching the throw the sheet would hit.
 * No static descriptor can express this: `CONFIG.DND5E.advancementTypes.HitPoints.validItemTypes`
 * lists `subclass` as valid, so a schema-shaped check stays silent on the exact broken document.
 *
 * ── Scope, honestly ─────────────────────────────────────────────────────────────────────────────
 * This detects ADVANCEMENT-preparation failures — the known, reported class. A document with no
 * prepared `advancement` index (Cypher, and most Item types) has nothing to probe and passes, which
 * is correct: it degrades to a no-op rather than guessing. It is NOT a universal "will any render
 * crash" oracle; a full headless sheet render would be, but it is heavy, version-fragile, and
 * disproportionate to the one failure mode that actually bites.
 */

'use strict'

/**
 * Advancement level-preview methods the sheet invokes while sorting/rendering the advancement tab.
 * Each takes a level context and is where a field-dependency crash surfaces. Called guarded, so a
 * method a given advancement type does not implement is simply skipped.
 */
const LEVEL_PREVIEW_METHODS = ['sortingValueForLevel', 'titleForLevel', 'valueForLevel']

// A minimal level context. The crashing accessors (e.g. HitPoints#hitDie) read the missing field
// regardless of level, so level 1 triggers them; richer levels would not catch anything more.
const PROBE_LEVELS = { character: 1, class: 1 }

/**
 * @param {Function} DocClass  e.g. `CONFIG.Item.documentClass`
 * @param {object} docData     the full document data about to be written
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function probeDocumentHealth(DocClass, docData) {
  if (typeof DocClass !== 'function') return { ok: true } // nothing to construct against; don't block
  if (!docData || typeof docData !== 'object') return { ok: true }

  let doc
  try {
    // Construction validates (bad ids, wrong field types) AND builds the prepared indices, but
    // swallows prep errors — so a throw here is a real, separate validation failure worth surfacing.
    doc = new DocClass(foundry.utils.deepClone(docData))
  } catch (err) {
    return { ok: false, reason: `Document is invalid: ${firstLine(err)}` }
  }

  // dnd5e exposes prepared advancement instances under `doc.advancement.byId`. Absent on systems /
  // document types without the advancement framework — nothing to probe.
  const byId = doc.advancement?.byId
  if (!byId || typeof byId !== 'object') return { ok: true }

  for (const advancement of Object.values(byId)) {
    if (!advancement) continue
    for (const method of LEVEL_PREVIEW_METHODS) {
      if (typeof advancement[method] !== 'function') continue
      try {
        advancement[method](PROBE_LEVELS)
      } catch (err) {
        const type = advancement.constructor?.name ?? advancement.type ?? 'advancement'
        return {
          ok: false,
          reason:
            `A ${type} on this "${doc.type}" fails to prepare: ${firstLine(err)}. ` +
            `This usually means an advancement kept from another document type reads a field this ` +
            `type does not have (e.g. a HitPoints advancement on a subclass, which has no hit die). ` +
            `Remove it, or the document will not open in Foundry.`,
        }
      }
    }
  }

  return { ok: true }
}

function firstLine(err) {
  return String(err?.message ?? err)
    .split('\n')[0]
    .slice(0, 120)
}
