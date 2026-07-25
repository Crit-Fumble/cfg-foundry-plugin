/**
 * CFG Journal Pull-Sync (#184 Phase 2 → engine config, dt#248) — the journal CONFIG for
 * the generic document pull-sync.
 *
 * The bespoke class this replaces predated the engine (dt#244) and duplicated its whole
 * control flow — election, busy-guard, plan/ack loop, create-if-absent with `keepId`, and
 * a page reconciler identical to the engine's embedded reconciliation. Folding it onto
 * `DocPullSync` retires that duplicate and picks up what the bespoke path lacked: the
 * document health probe before create (dt#213) and `world_deleted` parking whenever the
 * server starts sending `everPushed`.
 *
 * ## Journal-specific facts the config encodes
 *
 *   · IDs ARE DERIVED, AND THAT IS LOAD-BEARING. `docData._id` comes from the platform
 *     entry id (deriveFoundryEntryId server-side), so create-if-absent is an exact match
 *     and a re-sync updates in place — but only because the engine passes `{keepId: true}`.
 *   · Pages are an embedded collection: updating them through the parent merges by `_id`
 *     and never REMOVES one, so a page deleted on the platform would linger in the world
 *     forever. The engine's embedded reconciliation handles create/update/delete.
 *   · A JournalEntry has no `type` and no `system` block → `checkSystem: false`, and the
 *     engine's type-change recreate can never trigger.
 *
 * Direction is platform→Foundry on this leg; the world→platform half is
 * `world-journal-snapshot.js` (dt#247), with worldEditWins deciding conflicts server-side.
 */

'use strict'

import { DocPullSync } from './doc-pull-sync.js'

/** @type {import('./doc-pull-sync.js').DocSyncConfig} */
const JOURNAL_CONFIG = {
  label: 'JournalPull',
  noun: 'journal entry',
  collection: () => game.journal,
  DocClass: () => JournalEntry,
  probeClass: () => CONFIG?.JournalEntry?.documentClass,
  checkSystem: false, // narrative HTML — system-agnostic
  platformIdKey: 'journalEntryId',
  foundryIdKey: 'foundryEntryId',
  getPlan: (api, inst, world) => api.getJournalSyncPlan(inst, world),
  ack: (api, inst, world, _system, results) => api.ackJournalSync(inst, world, results),
  embedded: [{ name: 'JournalEntryPage', field: 'pages', of: (live) => live.pages }],
}

export class JournalPullSync extends DocPullSync {
  /**
   * @param {import('../clients/api-client.js').CoreAPIClient} apiClient
   * @param {string} installationId
   */
  constructor(apiClient, installationId) {
    super(apiClient, installationId, JOURNAL_CONFIG)
  }
}
