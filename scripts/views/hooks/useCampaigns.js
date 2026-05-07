/**
 * useCampaigns Hook
 * Manages linked campaigns and active campaign state for the Foundry world
 */

const MODULE_ID = 'crit-fumble-core'

export class useCampaigns {
  constructor() {
    /** @type {Array} Full campaign data from Core API */
    this.campaigns = []

    /** @type {Array} Linked campaign records from world settings */
    this.linkedCampaigns = []

    /** @type {string|null} Currently active campaign ID */
    this.activeCampaignId = null

    /** @type {string} Filter mode: 'all' | 'campaign' | 'party' */
    this.filterMode = 'all'

    /** @type {boolean} Loading state */
    this.loading = false

    /** @type {string|null} Error message */
    this.error = null
  }

  /* -------------------------------------------- */
  /*  Data Loading                                */
  /* -------------------------------------------- */

  /**
   * Load all campaign data from settings and API
   * @returns {Promise<useCampaigns>} Self for chaining
   */
  async load() {
    this.loading = true
    this.error = null

    try {
      // Load from world settings
      this.linkedCampaigns = game.settings.get(MODULE_ID, 'linkedCampaigns') || []
      this.activeCampaignId = game.settings.get(MODULE_ID, 'activeCampaignId') || null
      this.filterMode = game.settings.get(MODULE_ID, 'campaignFilterMode') || 'all'

      // Fetch full campaign data from API (if available)
      const api = window.CritFumbleCore?.apiClient
      if (api) {
        try {
          const response = await api.getCampaigns()
          this.campaigns = response.campaigns || []
        } catch (apiError) {
          console.warn('[useCampaigns] API fetch failed, using cached data:', apiError.message)
          // Use linked campaign names as fallback
          this.campaigns = this.linkedCampaigns.map((lc) => ({
            id: lc.campaignId,
            name: lc.name,
            _cached: true,
          }))
        }
      }
    } catch (error) {
      this.error = error.message
      console.error('[useCampaigns] Load failed:', error)
    } finally {
      this.loading = false
    }

    return this
  }

  /**
   * Reload data from settings (without API call)
   */
  refresh() {
    this.linkedCampaigns = game.settings.get(MODULE_ID, 'linkedCampaigns') || []
    this.activeCampaignId = game.settings.get(MODULE_ID, 'activeCampaignId') || null
    this.filterMode = game.settings.get(MODULE_ID, 'campaignFilterMode') || 'all'
  }

  /* -------------------------------------------- */
  /*  Getters                                     */
  /* -------------------------------------------- */

  /**
   * Get linked campaign record by campaign ID
   * @param {string} campaignId
   * @returns {object|null}
   */
  getLinked(campaignId) {
    return this.linkedCampaigns.find((c) => c.campaignId === campaignId) || null
  }

  /**
   * Get full campaign data by ID
   * @param {string} campaignId
   * @returns {object|null}
   */
  getCampaign(campaignId) {
    return this.campaigns.find((c) => c.id === campaignId) || null
  }

  /**
   * Get active campaign (full data)
   * @returns {object|null}
   */
  getActive() {
    if (!this.activeCampaignId) return null
    return this.getCampaign(this.activeCampaignId)
  }

  /**
   * Get active linked campaign record
   * @returns {object|null}
   */
  getActiveLinked() {
    if (!this.activeCampaignId) return null
    return this.getLinked(this.activeCampaignId)
  }

  /**
   * Check if a campaign is linked
   * @param {string} campaignId
   * @returns {boolean}
   */
  isLinked(campaignId) {
    return this.linkedCampaigns.some((c) => c.campaignId === campaignId)
  }

  /**
   * Check if a campaign is the active one
   * @param {string} campaignId
   * @returns {boolean}
   */
  isActive(campaignId) {
    return this.activeCampaignId === campaignId
  }

  /**
   * Get all linked campaign IDs
   * @returns {Array<string>}
   */
  getLinkedIds() {
    return this.linkedCampaigns.map((c) => c.campaignId)
  }

  /**
   * Get campaigns available to link (not already linked)
   * @returns {Array}
   */
  getAvailable() {
    const linkedIds = new Set(this.getLinkedIds())
    return this.campaigns.filter((c) => !linkedIds.has(c.id))
  }

  /* -------------------------------------------- */
  /*  Mutations                                   */
  /* -------------------------------------------- */

  /**
   * Link a campaign to this world
   * @param {string} campaignId
   * @param {string} name - Campaign name (for display)
   * @returns {Promise<boolean>}
   */
  async link(campaignId, name) {
    if (this.isLinked(campaignId)) {
      console.warn('[useCampaigns] Campaign already linked:', campaignId)
      return false
    }

    const newLinked = {
      campaignId,
      name,
      linkedAt: Date.now(),
      syncedAt: null,
      partyIds: [],
    }

    this.linkedCampaigns.push(newLinked)
    await game.settings.set(MODULE_ID, 'linkedCampaigns', this.linkedCampaigns)

    console.log('[useCampaigns] Linked campaign:', name)
    return true
  }

  /**
   * Unlink a campaign from this world
   * @param {string} campaignId
   * @returns {Promise<boolean>}
   */
  async unlink(campaignId) {
    const index = this.linkedCampaigns.findIndex((c) => c.campaignId === campaignId)
    if (index < 0) {
      console.warn('[useCampaigns] Campaign not linked:', campaignId)
      return false
    }

    const removed = this.linkedCampaigns.splice(index, 1)[0]
    await game.settings.set(MODULE_ID, 'linkedCampaigns', this.linkedCampaigns)

    // Clear active if it was this campaign
    if (this.activeCampaignId === campaignId) {
      await this.setActive(null)
    }

    console.log('[useCampaigns] Unlinked campaign:', removed.name)
    return true
  }

  /**
   * Set the active campaign
   * @param {string|null} campaignId - Campaign ID or null to clear
   * @returns {Promise<boolean>}
   */
  async setActive(campaignId) {
    if (campaignId && !this.isLinked(campaignId)) {
      console.warn('[useCampaigns] Cannot set active: campaign not linked')
      return false
    }

    this.activeCampaignId = campaignId
    await game.settings.set(MODULE_ID, 'activeCampaignId', campaignId || '')

    console.log('[useCampaigns] Active campaign set:', campaignId || '(none)')
    return true
  }

  /**
   * Set the filter mode
   * @param {'all'|'campaign'|'party'} mode
   * @returns {Promise<boolean>}
   */
  async setFilterMode(mode) {
    if (!['all', 'campaign', 'party'].includes(mode)) {
      console.warn('[useCampaigns] Invalid filter mode:', mode)
      return false
    }

    this.filterMode = mode
    await game.settings.set(MODULE_ID, 'campaignFilterMode', mode)

    console.log('[useCampaigns] Filter mode set:', mode)
    return true
  }

  /**
   * Update linked campaign data (after sync)
   * @param {string} campaignId
   * @param {object} updates - Fields to update (name, syncedAt, partyIds)
   * @returns {Promise<boolean>}
   */
  async updateLinked(campaignId, updates) {
    const linked = this.getLinked(campaignId)
    if (!linked) {
      console.warn('[useCampaigns] Cannot update: campaign not linked')
      return false
    }

    Object.assign(linked, updates)
    await game.settings.set(MODULE_ID, 'linkedCampaigns', this.linkedCampaigns)

    return true
  }

  /* -------------------------------------------- */
  /*  API Integration                             */
  /* -------------------------------------------- */

  /**
   * Sync a campaign from Core API
   * @param {string} campaignId
   * @returns {Promise<object|null>} Updated campaign data
   */
  async syncCampaign(campaignId) {
    const api = window.CritFumbleCore?.apiClient
    if (!api) {
      console.error('[useCampaigns] API client not available')
      return null
    }

    try {
      const response = await api.getCampaign(campaignId)
      const campaign = response.campaign || response

      // Update campaigns array
      const index = this.campaigns.findIndex((c) => c.id === campaignId)
      if (index >= 0) {
        this.campaigns[index] = campaign
      } else {
        this.campaigns.push(campaign)
      }

      // Update linked record
      await this.updateLinked(campaignId, {
        name: campaign.name,
        syncedAt: Date.now(),
        partyIds: campaign.parties?.map((p) => p.id) || [],
      })

      return campaign
    } catch (error) {
      console.error('[useCampaigns] Sync failed:', error)
      return null
    }
  }

  /**
   * Fetch available campaigns from API
   * @returns {Promise<Array>}
   */
  async fetchAvailable() {
    const api = window.CritFumbleCore?.apiClient
    if (!api) return []

    try {
      const worldId = game.settings.get(MODULE_ID, 'linkedWorldId')
      const response = await api.getAvailableCampaigns(worldId)
      return response.campaigns || []
    } catch (error) {
      console.error('[useCampaigns] Fetch available failed:', error)
      return []
    }
  }
}
