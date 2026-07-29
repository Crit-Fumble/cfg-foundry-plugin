/**
 * CFG Folder Pull-Sync (dt#250 slice 2) — the folder CONFIG for the generic engine.
 *
 * Carries a GM's platform folder work into the live world: create (platform-born
 * folders are the first claim-is-the-queue entity with a creation path — `everPushed:
 * false` rides the plan item so the engine takes its `{keepId: true}` create branch),
 * rename / move / recolor / re-sort (plain update; `folder: null` and `color: null`
 * both clear — measured), and delete (`deleted: true` items — the engine issues the
 * plain folder-only delete; children and contents promote to ROOT, measured v14.361).
 *
 * ## What differs from the earlier configs
 *
 *   · No embedded collections at all — the simplest document the engine syncs.
 *   · `typeIsImmutable: false` — measured: `update({type})` genuinely re-types a live
 *     Folder (the Macro behavior, not the Actor one). The knob is set to what was
 *     measured, but the server never sends a type change: a re-typed folder strands
 *     every document pointing at it, so `folderType` is immutable at the routes.
 *   · No `system` block → `checkSystem: false`.
 *
 * Removal markers, MEASURED live (v14.361, dt#250 probe): `-=color` and nested flags
 * markers work; `-=description` / `-=sort` / `-=sorting` / `-=folder` are accepted and
 * SILENTLY IGNORED (`-=folder` works on an Actor, `-=sort` on a Macro — nothing
 * generalizes). None are exercised: the plan's docData always carries `folder` and
 * `color` explicitly, null included.
 */

'use strict'

import { DocPullSync } from './doc-pull-sync.js'

/** @type {import('./doc-pull-sync.js').DocSyncConfig} */
const FOLDER_CONFIG = {
  label: 'FolderPull',
  noun: 'folder',
  collection: () => game.folders,
  DocClass: () => Folder,
  probeClass: () => CONFIG?.Folder?.documentClass,
  checkSystem: false,
  typeIsImmutable: false,
  platformIdKey: 'platformId',
  foundryIdKey: 'foundryFolderId',
  getPlan: (api, inst, world) => api.getFolderSyncPlan(inst, world),
  ack: (api, inst, world, _system, results) => api.ackFolderSync(inst, world, results),
}

export class FolderPullSync extends DocPullSync {
  /**
   * @param {import('../clients/api-client.js').CoreAPIClient} apiClient
   * @param {string} installationId
   */
  constructor(apiClient, installationId) {
    super(apiClient, installationId, FOLDER_CONFIG)
  }
}
