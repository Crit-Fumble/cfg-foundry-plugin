/**
 * CFG Character Pull-Sync (cfs#17 #147)
 *
 * The Core→Foundry write-back loop. When a player edits a character sheet on the
 * platform, the server flips that character's FoundryActorSync record to
 * `syncStatus: 'pending'`, `lastSyncFrom: 'core'` and re-baselines its
 * `lastPushedData` to the (newly-edited) stored Foundry actor. The platform never
 * touches the live VTT — a connected GM client has to carry the edit across.
 *
 * Each tick, the elected GM reporter pulls those pending+core records for every
 * linked campaign and, for each one whose live Foundry actor exists:
 *   1. applies the character's `characterSheetData.foundry.actor` (system + items)
 *      to the live actor via CharacterSyncManager.updateActorFromCharacter, then
 *   2. pushes the updated actor back through the normal Foundry→Core sync endpoint.
 *
 * Closing the loop via that push is deliberate: the actor we just applied matches
 * the server's re-baselined `lastPushedData`, so detectConflicts finds no conflict
 * → the server marks the record `synced` (lastSyncFrom: 'foundry') and re-baselines
 * again. No new endpoint needed; "core and foundry now agree" is the synced state.
 *
 * Single-reporter election mirrors WorldActorSnapshot: a human GM (smallest id)
 * does the work, falling back to the lone service-GM only when it is the sole GM.
 * A GM is required because only a GM sees every actor with full source data.
 *
 * Auth + transport: the shared CoreAPIClient attaches the world's installation /
 * paired key (session-cookie fallback). All failures are non-fatal — a missed tick
 * just leaves the record pending for the next sweep.
 */

'use strict'

const LOG = 'CFG Core | CharPull |'

const PULL_MS = 30_000 // poll cadence — snappy enough for "edit then see it in Foundry"

// Matches SERVICE_GM_NATIVE_ID in cfg-core-server. Preferred reporter is a human
// GM; the service-GM only reports when it is the sole connected GM.
const SERVICE_GM_ID = 'CFGServiceGM0000'

export class CharacterPullSync {
  /**
   * @param {import('../clients/api-client.js').CoreAPIClient} apiClient
   * @param {import('./character-sync.js').CharacterSyncManager} syncManager — applies foundry.actor to a live actor
   * @param {() => string[]} getLinkedCampaignIds — returns the campaigns linked to this world
   */
  constructor(apiClient, syncManager, getLinkedCampaignIds) {
    this._api = apiClient
    this._syncManager = syncManager
    this._getLinkedCampaignIds = getLinkedCampaignIds
    this._handle = null
    this._busy = false
  }

  /** Begin pulling. Call once on module ready from a GM client (linked world). */
  start() {
    this._tick().catch((err) => console.debug?.(`${LOG} initial tick skipped:`, err?.message || err))
    this._handle = setInterval(() => {
      this._tick().catch((err) => console.debug?.(`${LOG} tick skipped:`, err?.message || err))
    }, PULL_MS)
    console.log(`${LOG} pull-sync started`)
  }

  stop() {
    if (this._handle) {
      clearInterval(this._handle)
      this._handle = null
    }
  }

  /** Elected reporter id: smallest human-GM id, or the lone service-GM. */
  _electedReporterId() {
    const gms = game.users.filter((u) => u.active && u.isGM)
    if (gms.length === 0) return null
    const humans = gms.filter((u) => u.id !== SERVICE_GM_ID)
    const pool = humans.length ? humans : gms
    return pool.map((u) => u.id).sort()[0]
  }

  _isReporter() {
    const id = this._electedReporterId()
    return !!id && game.user?.id === id
  }

  async _tick() {
    if (this._busy) return // a slow tick must not overlap the next one
    if (!this._isReporter()) return

    const campaignIds = this._getLinkedCampaignIds?.() ?? []
    if (campaignIds.length === 0) return

    this._busy = true
    try {
      for (const campaignId of campaignIds) {
        try {
          await this._syncCampaign(campaignId)
        } catch (err) {
          // One bad campaign must not stall the rest.
          console.debug?.(`${LOG} campaign ${campaignId} skipped:`, err?.message || err)
        }
      }
    } finally {
      this._busy = false
    }
  }

  /** Pull this campaign's pending+core records and carry each across to Foundry. */
  async _syncCampaign(campaignId) {
    const syncList = (await this._api.getSyncRecords(campaignId)) ?? {}
    const syncs = Array.isArray(syncList.syncs) ? syncList.syncs : []

    // One characters fetch per campaign per tick; index by id for O(1) lookup.
    const charById = await this._fetchCharacterMap(campaignId)

    // Bootstrap the mapping the whole loop depends on. A FoundryActorSync record
    // only ever gets created by an explicit register call; nothing in the live
    // product made one, so a platform edit had no record to flip to pending and
    // write-back could never start. Register the missing ones here, keyed on the
    // character's own foundry.actor._id (an exact link, not a guess).
    await this._ensureMappings(campaignId, syncs, charById)

    const pending = syncs.filter((s) => s.syncStatus === 'pending' && s.lastSyncFrom === 'core')
    for (const record of pending) {
      try {
        await this._applyOne(campaignId, record, charById)
      } catch (err) {
        // One bad record must not stop the others; it stays pending for next tick.
        console.debug?.(`${LOG} record ${record?.id} skipped:`, err?.message || err)
      }
    }
  }

  /**
   * Register a FoundryActorSync mapping for each linked character whose canonical
   * foundry.actor is live in THIS world but has no record yet. Guarded on "no
   * existing record" — re-registering resets a synced record to pending, so this
   * must only ever create, never touch a character that already has one.
   */
  async _ensureMappings(campaignId, syncs, charById) {
    const recorded = new Set((syncs || []).map((s) => s.characterId ?? s.character?.id).filter(Boolean))
    for (const [characterId, character] of charById) {
      if (recorded.has(characterId)) continue
      const foundryActorId = this._foundryActorOf(character)?._id
      if (!foundryActorId) continue // no canonical actor to map
      if (!game.actors.get(foundryActorId)) continue // that actor isn't in this world
      try {
        await this._api.registerActorMapping(campaignId, characterId, foundryActorId)
        console.log(`${LOG} registered mapping ${characterId} → ${foundryActorId}`)
      } catch (err) {
        // Non-fatal — a failed register just retries next tick.
        console.debug?.(`${LOG} mapping ${characterId} skipped:`, err?.message || err)
      }
    }
  }

  /**
   * Apply one pending record's platform edit to the live actor, then push it back
   * to close the loop (server sees core+foundry agree → marks the record synced).
   */
  async _applyOne(campaignId, record, charById) {
    const actor = game.actors.get(record.foundryActorId)
    if (!actor) return // actor not in this world (yet) — leave pending

    const character = charById.get(record.character?.id)
    if (!character || !this._foundryActorOf(character)) return // nothing to apply

    await this._syncManager.updateActorFromCharacter(actor, character)
    await this._api.pushActorSync(campaignId, [this._serializeActor(actor)])
  }

  /** Build a Map of character.id → character (with characterSheetData) for a campaign. */
  async _fetchCharacterMap(campaignId) {
    const map = new Map()
    const res = (await this._api.getCampaignCharacters(campaignId)) ?? {}
    // listCharacters returns { playerCharacters: [{ character, ... }], npcCharacters: [...] }.
    const fromPlayers = (res.playerCharacters ?? []).map((pc) => pc.character).filter(Boolean)
    const npcs = res.npcCharacters ?? []
    for (const character of [...fromPlayers, ...npcs]) {
      if (character?.id) map.set(character.id, character)
    }
    return map
  }

  /** The canonical Foundry actor stored on a Core character, or null. */
  _foundryActorOf(character) {
    // The platform stores the sheet either flat (characterSheetData) or nested
    // under sheetData depending on the endpoint; accept either shape.
    const sheet = character?.characterSheetData ?? character?.sheetData?.characterSheetData
    const actor = sheet?.foundry?.actor
    return actor && typeof actor === 'object' ? actor : null
  }

  /** Serialize a live actor for the Foundry→Core push (full source object). */
  _serializeActor(actor) {
    if (typeof actor.toObject === 'function') return actor.toObject()
    return {
      _id: actor.id,
      name: actor.name,
      system: actor.system,
      items: (actor.items ?? []).map((i) => (typeof i.toObject === 'function' ? i.toObject() : i)),
    }
  }
}
