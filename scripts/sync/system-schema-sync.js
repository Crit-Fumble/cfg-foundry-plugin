/**
 * Game-system document schema sync (dt#212)
 *
 * Introspects the system's own DataModels once per world ready and POSTs the resulting descriptors
 * to CFG, so the platform's JSON editor can warn a GM before Foundry throws their data away.
 *
 * ── Why this cannot be a static file ──────────────────────────────────────────────────────────
 * Foundry DISCARDS `system` fields that the target document type does not declare, silently — the
 * create resolves and the data is simply gone. Verified on dnd5e 5.3.3: a `subclass` built from a
 * copied class kept none of `hd`, `levels` or `primaryAbility`, and threw nothing. That is the
 * headline homebrew workflow, so the editor has to know the real shape.
 *
 * Modern systems (dnd5e among them) dropped `template.json` for code-defined DataModels, so the
 * only accurate description of a document type is the live model in the running world. Reading it
 * here also means the descriptor automatically tracks the system version actually installed, and
 * that every system — Cypher included — is described by this same code with nothing added.
 *
 * ── Deliberately shallow ──────────────────────────────────────────────────────────────────────
 * Top-level `system` keys only, plus which of them are required with no default. Deep per-field
 * type checking is Foundry's job at write time, and a mirror of it here would go stale faster than
 * it would help. See the matching note in @crit-fumble/shared's system-schema.
 *
 * GM-only and once per ready, mirroring modules-sync: every client sees the same CONFIG, so a
 * player push would only duplicate writes.
 */

'use strict'

import { getInstallationRef } from '../auth/host-context.js'
import { fetchCfg } from '../auth/pair-flow.js'

/**
 * Document classes worth describing.
 *
 * Item and Actor are what world compendium packs overwhelmingly hold, and they are where the
 * data-loss case bites. Others are listed because they cost nothing when absent — a system that
 * defines no dataModels for a class is skipped rather than sent as an empty descriptor.
 */
export const DESCRIBED_DOCUMENT_CLASSES = ['Item', 'Actor', 'JournalEntryPage']

/**
 * Snapshot the running system's document schemas and POST them to CFG.
 *
 * @returns {Promise<{ok: true, count: number} | {ok: false, reason: string, status?: number}>}
 */
export async function syncSystemSchemas() {
  if (!game?.user?.isGM) return { ok: false, reason: 'not-gm' }

  const schemas = readSystemSchemas()
  if (schemas.length === 0) return { ok: false, reason: 'no-data-models' }

  // On a cfg-hosted world fetchCfg authenticates with the same-origin SESSION cookie and never the
  // paired key (#43). A cookie identifies a user, not an installation, so the installation has to
  // be named explicitly or the server cannot bind the push — the exact omission that made module
  // sync 403 on every hosted world (dt#211). Harmless on self-hosted, where the key already
  // carries the binding and the server ignores this field.
  const installationId = getInstallationRef()
  const res = await fetchCfg('/api/v1/foundry/system-schema', {
    method: 'POST',
    body: JSON.stringify(installationId ? { schemas, installationId } : { schemas }),
  })

  if (res.ok) {
    console.log(`CFG Core | Synced ${schemas.length} system schema descriptor(s)`)
    return { ok: true, count: schemas.length }
  }

  // Non-fatal, and deliberately not surfaced as a banner: the editor's documented behaviour with
  // no descriptor is to stay silent, so a failed push degrades to the pre-dt#212 experience rather
  // than to a broken one.
  console.warn('CFG Core | System schema sync skipped:', res.reason, res.status ?? '')
  return { ok: false, reason: res.reason, status: res.status }
}

/**
 * Project every described document class into wire-shape descriptors.
 *
 * @returns {Array<{systemId: string, systemVersion?: string, documentClass: string, types: object}>}
 */
export function readSystemSchemas() {
  const systemId = game?.system?.id
  if (!systemId) return []
  const systemVersion = game?.system?.version

  const out = []
  for (const documentClass of DESCRIBED_DOCUMENT_CLASSES) {
    const dataModels = globalThis.CONFIG?.[documentClass]?.dataModels
    if (!dataModels || typeof dataModels !== 'object') continue

    const types = {}
    for (const [typeName, model] of Object.entries(dataModels)) {
      const described = describeModel(model)
      if (described) types[typeName] = described
    }

    // A class whose models all failed to introspect is not worth sending: an empty `types` map
    // would read downstream as "this system declares no types", and the checker's silence on an
    // unknown type is the honest answer there.
    if (Object.keys(types).length === 0) continue

    out.push({
      systemId: String(systemId),
      ...(systemVersion ? { systemVersion: String(systemVersion) } : {}),
      documentClass,
      types,
    })
  }
  return out
}

/**
 * Describe one DataModel's schema: the top-level `system` keys it allows, and which of those are
 * required with no default to fall back on.
 *
 * `schema.fields` is the field map. Foundry exposes it directly on the model class's static
 * `schema`, but systems have historically also handed back a callable `defineSchema`, so both are
 * tried before giving up. Anything unrecognised returns null rather than a guess — a wrong
 * descriptor would warn that valid fields are about to be discarded, which is worse than none.
 *
 * @returns {{fields: string[], required?: string[]} | null}
 */
export function describeModel(model) {
  const fields = resolveSchemaFields(model)
  if (!fields) return null

  const names = Object.keys(fields)
  const required = names.filter((name) => isRequiredWithoutDefault(fields[name]))
  const requiredNonEmpty = names.filter((name) => isRequiredButBlankByDefault(fields[name]))

  const out = { fields: names }
  if (required.length > 0) out.required = required
  if (requiredNonEmpty.length > 0) out.requiredNonEmpty = requiredNonEmpty
  return out
}

/** Pull the `{name: DataField}` map off a model, tolerating the shapes Foundry has used. */
function resolveSchemaFields(model) {
  if (!model) return null
  try {
    const schema = model.schema ?? (typeof model.defineSchema === 'function' ? model.defineSchema() : null)
    if (!schema) return null
    // A SchemaField wraps its map in `.fields`; `defineSchema()` returns the bare map.
    const fields = schema.fields ?? schema
    if (!fields || typeof fields !== 'object') return null
    return fields
  } catch {
    // Introspection must never break world load. A system that throws here simply goes undescribed.
    return null
  }
}

/**
 * Is this field one the GM must supply themselves?
 *
 * `required` alone is not the question — most Foundry fields are required AND carry an `initial`,
 * so the model fills them in and the GM never has to. The ones worth erroring on are required with
 * nothing to fall back on: a subclass without `classIdentifier` attaches to no class, which is the
 * other half of the class-to-subclass conversion this feature exists for.
 */
/**
 * Is this a field the system requires but hands you an EMPTY STRING for?
 *
 * These are the ones that actually bite. `isRequiredWithoutDefault` above finds nothing on dnd5e
 * because every field has a default — but a default of `""` is a placeholder, not a value. A
 * subclass whose `classIdentifier` is `""` loads cleanly and attaches to no class, and "is the key
 * missing?" can never see it because the key is always there.
 *
 * Confined to STRING defaults on purpose. An empty object default (`description` → `{value, chat}`,
 * `advancement` → `{}`) is a perfectly normal resting state, and flagging those would bury the one
 * finding that matters in noise.
 */
function isRequiredButBlankByDefault(field) {
  if (!field || typeof field !== 'object') return false
  if (field.required !== true) return false
  if (field.nullable === true) return false
  try {
    if (typeof field.getInitialValue !== 'function') return field.initial === ''
    return field.getInitialValue({}) === ''
  } catch {
    return false
  }
}

function isRequiredWithoutDefault(field) {
  if (!field || typeof field !== 'object') return false
  if (field.required !== true) return false
  if (field.nullable === true) return false

  // A Foundry field's default lives behind `getInitialValue()`, NOT the `initial` property.
  // Verified against live dnd5e 5.3.3: every one of subclass's six fields has
  // `required: true, nullable: false, initial: undefined` — and every one returns a real default
  // from `getInitialValue({})` (`identifier` → "", `description` → {value,chat},
  // `source` → {revision,rules}). Testing `initial` therefore marked ALL SIX required and would
  // have errored on every well-formed subclass, which is the confidently-wrong failure this
  // module is supposed to avoid.
  //
  // A consequence worth knowing: on dnd5e this set is EMPTY, including `classIdentifier` — the
  // system defaults it to "" rather than leaving it absent, so "a subclass with no
  // classIdentifier" is an empty value, not a missing field, and is not detectable from the
  // schema. The discard warning is the load-bearing half; this half stays for systems that do
  // declare genuinely defaultless fields.
  try {
    if (typeof field.getInitialValue === 'function') return field.getInitialValue({}) === undefined
  } catch {
    // A field whose initial-value machinery throws tells us nothing; claiming it is required
    // would be a guess.
    return false
  }
  return field.initial === undefined
}
