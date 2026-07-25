/**
 * CFG Scene Pull-Sync (dt#246) — the scene CONFIG for the generic engine.
 *
 * Carries a platform-authored scene into the LIVE world, creating it when absent. Scenes
 * are the JOURNAL case rather than the macro one: `LocationScene` mirrors
 * `CoreJournalEntry`'s scope model, so a scene can exist on the platform with no world
 * counterpart at all.
 *
 * ## Nine embedded collections
 *
 * A Scene carries tokens, walls, lights, sounds, drawings, notes, tiles, regions and levels
 * — every one of which merges by `_id` through a parent update and is NEVER removed by it.
 * All nine are listed here, but the engine reconciles a collection ONLY when the desired doc
 * actually contains it (`Array.isArray(desired)`), so anything the platform does not model
 * is left completely alone rather than emptied.
 *
 * ## Measured (Foundry v14.361)
 *
 *   · `Scene.create(doc, {keepId:true})` → id preserved
 *   · updating the ACTIVE scene           → safe: stays active, no throw, canvas keeps it
 *   · token create/delete with keepId     → works
 *   · `flags.*` and `background.src` markers → both work
 *   · no `system` block                   → `checkSystem: false`
 *   · Scenes have no `type`               → the type-change branch never fires; the knob is
 *                                           left at its safe default rather than tuned
 */

'use strict'

import { DocPullSync } from './doc-pull-sync.js'

/** @type {import('./doc-pull-sync.js').DocSyncConfig} */
const SCENE_CONFIG = {
  label: 'ScenePull',
  noun: 'scene',
  collection: () => game.scenes,
  DocClass: () => Scene,
  probeClass: () => CONFIG?.Scene?.documentClass,
  checkSystem: false,
  // NEVER write `active`. It is settable through a plain create/update on v14.361, so a doc
  // carrying it changes which scene every connected player is looking at — and could leave
  // two scenes marked active, since only .activate() deactivates the others. The server
  // strips it too; a live spec proved BOTH sides need to, because the create path here
  // happily activated a scene when only the server guarded it.
  stripFields: ['active'],
  platformIdKey: 'sceneId',
  foundryIdKey: 'foundrySceneId',
  getPlan: (api, inst, world) => api.getSceneSyncPlan(inst, world),
  ack: (api, inst, world, _system, results) => api.ackSceneSync(inst, world, results),
  embedded: [
    { name: 'Token', field: 'tokens', of: (live) => live.tokens },
    { name: 'Wall', field: 'walls', of: (live) => live.walls },
    { name: 'AmbientLight', field: 'lights', of: (live) => live.lights },
    { name: 'AmbientSound', field: 'sounds', of: (live) => live.sounds },
    { name: 'Drawing', field: 'drawings', of: (live) => live.drawings },
    { name: 'Note', field: 'notes', of: (live) => live.notes },
    { name: 'Tile', field: 'tiles', of: (live) => live.tiles },
    { name: 'Region', field: 'regions', of: (live) => live.regions },
  ],
}

export class ScenePullSync extends DocPullSync {
  /**
   * @param {import('../clients/api-client.js').CoreAPIClient} apiClient
   * @param {string} installationId
   */
  constructor(apiClient, installationId) {
    super(apiClient, installationId, SCENE_CONFIG)
  }
}
