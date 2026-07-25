/**
 * CFG Macro Pull-Sync (dt#245) — the macro CONFIG for the generic engine.
 *
 * ## The bug this closes
 *
 * Since dt#214 a GM could edit a macro in PlayTable, the platform staked a
 * `platformEditedAt` claim, and `ingestWorldMacros` dutifully held that claim against the
 * next snapshot — then RELEASED it once the world's own clock moved past. Nothing ever
 * carried the edit into Foundry. The edit was held for a while, then silently discarded.
 *
 * ## Why this file is 40 lines
 *
 * Everything hard — keepId on create, embedded reconciliation, nested `-=` markers,
 * `world_deleted` vs create, the single-reporter election, per-item error isolation — lives
 * in `doc-pull-sync.js` (dt#244). A macro is the simplest possible exercise of that engine.
 *
 * ## Measured differences from an Actor (Foundry v14.361) — probed, not assumed
 *
 *   · `update({type})` script→chat **WORKS**, so `typeIsImmutable: false`. An Actor
 *     silently keeps its old type and needs delete+recreate; doing that to a Macro would
 *     destroy and re-create the document for no reason.
 *   · No `system` block → `checkSystem: false`.
 *   · No embedded collections → nothing to reconcile.
 *   · (`-=img` works here where it THROWS on an Actor; `-=command` is silently ignored.
 *     Both are the server's concern — it decides which paths are eligible.)
 */

'use strict'

import { DocPullSync } from './doc-pull-sync.js'

/** @type {import('./doc-pull-sync.js').DocSyncConfig} */
const MACRO_CONFIG = {
  label: 'MacroPull',
  noun: 'macro',
  collection: () => game.macros,
  DocClass: () => Macro,
  probeClass: () => CONFIG?.Macro?.documentClass,
  checkSystem: false,
  typeIsImmutable: false, // measured: script→chat via update() works
  platformIdKey: 'platformId',
  foundryIdKey: 'foundryMacroId',
  getPlan: (api, inst, world) => api.getMacroSyncPlan(inst, world),
  ack: (api, inst, world, _system, results) => api.ackMacroSync(inst, world, results),
  // No embedded collections on a Macro.
}

export class MacroPullSync extends DocPullSync {
  /**
   * @param {import('../clients/api-client.js').CoreAPIClient} apiClient
   * @param {string} installationId
   */
  constructor(apiClient, installationId) {
    super(apiClient, installationId, MACRO_CONFIG)
  }
}
