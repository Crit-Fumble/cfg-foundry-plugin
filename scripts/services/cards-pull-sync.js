/**
 * CFG Cards Pull-Sync (dt#249) — the card-stack CONFIG for the generic engine.
 *
 * Macro-shaped lifecycle (no platform-native creation path; the claim is the queue), with
 * ONE embedded collection — `cards` — where the stack's content lives.
 *
 * ## Measured (v14, dt#249 probe) — a Cards stack is the ACTOR case for `type`
 *
 *   · `update({type})` deck→hand resolves and SILENTLY KEEPS the old type — the same
 *     behavior as Actor, and the opposite of Macro. So `typeIsImmutable` stays at its
 *     default (true): a type change is delete + create with keepId, which the engine
 *     already does.
 *   · `-=img` and nested flags markers work; `-=description` and `-=sort` are accepted
 *     and silently ignored — note `-=description` WORKS on a Playlist. Per-type, always.
 *   · Cards DOES carry a `system` block, unlike Macro/RollTable/Playlist. `checkSystem`
 *     stays false anyway: every doc in this flow is a same-world round-trip (mirror-only
 *     lifecycle), so there is no foreign-system doc to refuse. Revisit if Cards ever
 *     gains a platform-native creation path.
 */

'use strict'

import { DocPullSync } from './doc-pull-sync.js'

/** @type {import('./doc-pull-sync.js').DocSyncConfig} */
const CARDS_CONFIG = {
  label: 'CardsPull',
  noun: 'card stack',
  collection: () => game.cards,
  DocClass: () => Cards,
  probeClass: () => CONFIG?.Cards?.documentClass,
  checkSystem: false,
  platformIdKey: 'platformId',
  foundryIdKey: 'foundryCardsId',
  getPlan: (api, inst, world) => api.getCardsSyncPlan(inst, world),
  ack: (api, inst, world, _system, results) => api.ackCardsSync(inst, world, results),
  embedded: [{ name: 'Card', field: 'cards', of: (live) => live.cards }],
}

export class CardsPullSync extends DocPullSync {
  /**
   * @param {import('../clients/api-client.js').CoreAPIClient} apiClient
   * @param {string} installationId
   */
  constructor(apiClient, installationId) {
    super(apiClient, installationId, CARDS_CONFIG)
  }
}
