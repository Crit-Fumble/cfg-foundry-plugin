/**
 * CFG RollTable Pull-Sync (dt#249) — the rolltable CONFIG for the generic engine.
 *
 * Carries a GM's platform edit of a mirrored roll table into the live world. Tables are
 * the MACRO case, not the journal one: they have no platform-native creation path, so
 * every plan item is `everPushed: true` (a table absent from the world was deleted by
 * the GM and must never be re-created) and the claim is the whole queue.
 *
 * ## What differs from a Macro
 *
 *   · ONE embedded collection — `results` — and that is where the table's content
 *     lives. It merges by `_id` through a parent update and is never removed by one,
 *     so the engine reconciles it (create the rows the desired doc adds, delete the
 *     rows it dropped). The engine only reconciles when the desired doc actually
 *     carries a `results` array, so a doc without one leaves the world's rows alone.
 *   · No top-level `type` field at all, so the type-change branch never fires; the
 *     knob stays at its safe default rather than being tuned untested.
 *   · No `system` block → `checkSystem: false`, same as Macro.
 *
 * Removal markers, MEASURED live (v14, dt#249 probe): `-=img`, `-=formula` and nested
 * flags markers work; `-=description` / `-=replacement` / `-=displayRoll` / `-=sort` are
 * accepted and silently ignored (where `-=sort` works on a Macro — they do not
 * generalize). Which paths are eligible is the server's concern; the engine here just
 * applies what it is sent.
 */

'use strict'

import { DocPullSync } from './doc-pull-sync.js'

/** @type {import('./doc-pull-sync.js').DocSyncConfig} */
const ROLLTABLE_CONFIG = {
  label: 'RollTablePull',
  noun: 'roll table',
  collection: () => game.tables,
  DocClass: () => RollTable,
  probeClass: () => CONFIG?.RollTable?.documentClass,
  checkSystem: false,
  platformIdKey: 'platformId',
  foundryIdKey: 'foundryRollTableId',
  getPlan: (api, inst, world) => api.getRollTableSyncPlan(inst, world),
  ack: (api, inst, world, _system, results) => api.ackRollTableSync(inst, world, results),
  embedded: [{ name: 'TableResult', field: 'results', of: (live) => live.results }],
}

export class RollTablePullSync extends DocPullSync {
  /**
   * @param {import('../clients/api-client.js').CoreAPIClient} apiClient
   * @param {string} installationId
   */
  constructor(apiClient, installationId) {
    super(apiClient, installationId, ROLLTABLE_CONFIG)
  }
}
