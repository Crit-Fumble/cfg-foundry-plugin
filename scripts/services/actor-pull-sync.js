/**
 * CFG Actor Pull-Sync (fp#46, fp#49) — the actor CONFIG for the generic engine (dt#244).
 *
 * Carries a platform character into the LIVE world, including CREATING it, which is the
 * whole point. Its predecessor could only ever UPDATE an actor that already existed:
 * `Actor.create` appeared nowhere in this plugin, and two gates bailed silently on an
 * absent actor (`if (!game.actors.get(id)) continue`, and `if (!actor) return // actor not
 * in this world (yet)`). That `(yet)` never came, so a character created in PlayTable was
 * invisible at the table forever.
 *
 * All the Foundry footwork — keepId on create, type-change recreate, embedded
 * reconciliation, nested `-=` markers, `world_deleted` vs create, the reporter election —
 * now lives in `doc-pull-sync.js` and is shared with every other entity. What is left here
 * is only what makes an ACTOR an actor:
 *
 *   · `game.actors` / `Actor` / `CONFIG.Actor.documentClass`
 *   · `checkSystem: true` — an Actor carries a `system` block that fails validation in a
 *     world running a different system. A JournalEntry has no equivalent, which is why
 *     this is a flag rather than engine behaviour.
 *   · two embedded collections: Items and ActiveEffects
 *
 * Direction is platform→Foundry. A GM's in-world edit is not clobbered blindly: the
 * server's mirror compares Foundry's own `_stats.modifiedTime` against the platform sheet's
 * clock and only plans a push when the platform genuinely moved last.
 */

'use strict'

import { DocPullSync, withRemovals } from './doc-pull-sync.js'

// Re-exported so the fp#49 marker tests keep importing it from here.
export { withRemovals }

/** @type {import('./doc-pull-sync.js').DocSyncConfig} */
const ACTOR_CONFIG = {
  label: 'ActorPull',
  noun: 'actor',
  collection: () => game.actors,
  DocClass: () => Actor,
  probeClass: () => CONFIG?.Actor?.documentClass,
  checkSystem: true,
  platformIdKey: 'characterId',
  foundryIdKey: 'foundryActorId',
  getPlan: (api, inst, world, system) => api.getActorSyncPlan(inst, world, system),
  ack: (api, inst, world, system, results) => api.ackActorSync(inst, world, system, results),
  embedded: [
    { name: 'Item', field: 'items', of: (live) => live.items },
    { name: 'ActiveEffect', field: 'effects', of: (live) => live.effects },
  ],
}

export class ActorPullSync extends DocPullSync {
  /**
   * @param {import('../clients/api-client.js').CoreAPIClient} apiClient
   * @param {string} installationId
   */
  constructor(apiClient, installationId) {
    super(apiClient, installationId, ACTOR_CONFIG)
  }
}
