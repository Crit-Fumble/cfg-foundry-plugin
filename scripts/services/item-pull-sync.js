/**
 * CFG STANDALONE ITEM Pull-Sync (dt#250) — the item CONFIG for the generic engine.
 *
 * Carries a GM's platform edit of a mirrored standalone item into the live world.
 * Items are the MACRO case for lifecycle: no platform-native creation path, so every
 * plan item is `everPushed: true` (an item absent from the world was deleted by the GM
 * and must never be re-created) and the claim is the whole queue.
 *
 * ## What differs from a RollTable
 *
 *   · The embedded collection is `effects` (ActiveEffect) — merges by `_id` through a
 *     parent update and is never removed by one, so the engine reconciles it. A doc
 *     without an `effects` array leaves the world's effects alone.
 *   · `update({type})` SILENTLY KEEPS the old type (measured 2026-07-29 — the Actor
 *     case, unlike Macro/Folder), so `typeIsImmutable` stays at its default and the
 *     engine delete+recreates on weapon→loot.
 *   · Items DO carry a `system` block, but every doc here is a same-world round-trip
 *     (mirror-only lifecycle) → `checkSystem: false`, the Cards precedent. Unknown
 *     `system` keys are DISCARDED and `system.-=` markers silently ignored (measured) —
 *     the DataModel re-materializes schema fields.
 *
 * Removal markers, MEASURED live (v14.361 / dnd5e, dt#250 probe): `-=img` and nested
 * flags markers work — note `-=img` THROWS on an Actor; they never generalize. Which
 * paths are eligible is the server's concern; the engine just applies what it is sent.
 */

'use strict'

import { DocPullSync } from './doc-pull-sync.js'

/** @type {import('./doc-pull-sync.js').DocSyncConfig} */
const ITEM_CONFIG = {
  label: 'ItemPull',
  noun: 'item',
  collection: () => game.items,
  DocClass: () => Item,
  probeClass: () => CONFIG?.Item?.documentClass,
  checkSystem: false,
  platformIdKey: 'platformId',
  foundryIdKey: 'foundryItemId',
  getPlan: (api, inst, world) => api.getItemSyncPlan(inst, world),
  ack: (api, inst, world, _system, results) => api.ackItemSync(inst, world, results),
  embedded: [{ name: 'ActiveEffect', field: 'effects', of: (live) => live.effects }],
}

export class ItemPullSync extends DocPullSync {
  /**
   * @param {import('../clients/api-client.js').CoreAPIClient} apiClient
   * @param {string} installationId
   */
  constructor(apiClient, installationId) {
    super(apiClient, installationId, ITEM_CONFIG)
  }
}
