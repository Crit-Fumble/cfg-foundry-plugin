/**
 * Sync Service
 * Lightweight sync between FoundryVTT and core.crit-fumble.com.
 *
 * Handles: quest sync (via QuestSyncManager), party roster, and active session info.
 * Does NOT handle: character sync, encounter sync, table sync, calendar sync,
 * entity sync, WA sync, field mapper, or bulk data operations.
 */

import { QuestSyncManager } from './quest-sync.js'
import { CampaignFlags } from '../utils/campaign-flags.js'

const MODULE_ID = 'crit-fumble-core'
const LOG = '[CFG Sync]'

export class SyncService {
  /**
   * @param {import('./api-client.js').CoreAPIClient} apiClient
   * @param {string} campaignId - Core campaign ID
   */
  constructor(apiClient, campaignId) {
    this.api = apiClient
    this.campaignId = campaignId

    /** @type {QuestSyncManager} */
    this._questSync = new QuestSyncManager(apiClient, null)

    /** @type {number|null} setInterval handle */
    this._interval = null
  }

  /* -------------------------------------------- */
  /*  Quest Sync                                   */
  /* -------------------------------------------- */

  /**
   * Pull quests from Core and sync them into Foundry journal entries.
   * Delegates fully to QuestSyncManager.
   * @returns {Promise<void>}
   */
  async syncQuests() {
    if (!this.campaignId) {
      console.warn(`${LOG} syncQuests: no campaignId configured`)
      return
    }
    try {
      await this._questSync.syncQuests(this.campaignId)
      console.log(`${LOG} Quest sync complete`)
    } catch (err) {
      console.error(`${LOG} Quest sync failed:`, err)
    }
  }

  /* -------------------------------------------- */
  /*  Party Roster                                 */
  /* -------------------------------------------- */

  /**
   * Pull the active party roster from Core and store it in module flags on the
   * world (accessible via game.settings / CampaignFlags) for other systems to read.
   * @returns {Promise<object[]>} Array of party objects, or empty array on failure.
   */
  async syncParty() {
    if (!this.campaignId) {
      console.warn(`${LOG} syncParty: no campaignId configured`)
      return []
    }
    try {
      const response = await this.api.request(`/api/campaigns/${this.campaignId}/parties`, { credentials: 'include' })
      const parties = response?.parties ?? []

      // Persist roster to world flags so other modules can read without an API call
      if (game.user.isGM) {
        await game.settings.set(MODULE_ID, 'cachedParties', JSON.stringify(parties))
      }

      console.log(`${LOG} Party sync: ${parties.length} party/parties loaded`)
      return parties
    } catch (err) {
      console.error(`${LOG} Party sync failed:`, err)
      return []
    }
  }

  /* -------------------------------------------- */
  /*  Active Session                               */
  /* -------------------------------------------- */

  /**
   * Fetch the currently active session for this campaign from Core.
   * Returns null if no session is active or on failure.
   * @returns {Promise<object|null>} Session object or null.
   */
  async syncActiveSession() {
    if (!this.campaignId) {
      console.warn(`${LOG} syncActiveSession: no campaignId configured`)
      return null
    }
    try {
      const response = await this.api.request(`/api/campaigns/${this.campaignId}/sessions/active`, {
        credentials: 'include',
      })
      const session = response?.session ?? null

      if (session) {
        console.log(`${LOG} Active session: "${session.name}" (${session.id})`)
      } else {
        console.log(`${LOG} No active session`)
      }

      return session
    } catch (err) {
      // A 404 is expected when there is no active session — treat as non-fatal
      if (err?.status === 404 || err?.message?.includes('404')) {
        return null
      }
      console.error(`${LOG} Active session fetch failed:`, err)
      return null
    }
  }

  /* -------------------------------------------- */
  /*  Auto-sync Interval                           */
  /* -------------------------------------------- */

  /**
   * Start a repeating sync interval that pulls quests, party roster, and
   * active session on a schedule.
   * @param {number} [intervalMinutes=5] - Minutes between each sync cycle.
   */
  startAutoSync(intervalMinutes = 5) {
    this.stopAutoSync()

    const ms = intervalMinutes * 60 * 1000

    this._interval = setInterval(async () => {
      console.log(`${LOG} Auto-sync tick`)
      await Promise.allSettled([this.syncQuests(), this.syncParty(), this.syncActiveSession()])
    }, ms)

    console.log(`${LOG} Auto-sync started (every ${intervalMinutes} min)`)
  }

  /**
   * Stop the auto-sync interval if running.
   */
  stopAutoSync() {
    if (this._interval !== null) {
      clearInterval(this._interval)
      this._interval = null
      console.log(`${LOG} Auto-sync stopped`)
    }
  }
}
