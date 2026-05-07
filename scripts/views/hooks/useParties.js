/**
 * useParties Hook
 * Manages party data for a specific campaign
 */

const MODULE_ID = 'crit-fumble-core'

export class useParties {
  /**
   * @param {string} campaignId - Campaign ID to load parties for
   */
  constructor(campaignId) {
    /** @type {string} Campaign this hook is managing parties for */
    this.campaignId = campaignId

    /** @type {Array} Parties in this campaign */
    this.parties = []

    /** @type {string|null} Currently selected party ID */
    this.selectedId = null

    /** @type {boolean} Loading state */
    this.loading = false

    /** @type {string|null} Error message */
    this.error = null
  }

  /* -------------------------------------------- */
  /*  Data Loading                                */
  /* -------------------------------------------- */

  /**
   * Load parties from API
   * @returns {Promise<useParties>} Self for chaining
   */
  async load() {
    if (!this.campaignId) {
      this.parties = []
      return this
    }

    this.loading = true
    this.error = null

    const api = window.CritFumbleCore?.apiClient
    if (!api) {
      this.error = 'API client not available'
      this.loading = false
      return this
    }

    try {
      const response = await api.getCampaignParties(this.campaignId)
      this.parties = response.parties || []
    } catch (error) {
      this.error = error.message
      console.error('[useParties] Load failed:', error)
    } finally {
      this.loading = false
    }

    return this
  }

  /**
   * Reload parties
   * @returns {Promise<useParties>}
   */
  async refresh() {
    return this.load()
  }

  /* -------------------------------------------- */
  /*  Getters                                     */
  /* -------------------------------------------- */

  /**
   * Get all parties
   * @returns {Array}
   */
  getAll() {
    return this.parties
  }

  /**
   * Get party by ID
   * @param {string} partyId
   * @returns {object|null}
   */
  getParty(partyId) {
    return this.parties.find((p) => p.id === partyId) || null
  }

  /**
   * Get currently selected party
   * @returns {object|null}
   */
  getSelected() {
    if (!this.selectedId) return null
    return this.getParty(this.selectedId)
  }

  /**
   * Get party by name
   * @param {string} name
   * @returns {object|null}
   */
  getByName(name) {
    return this.parties.find((p) => p.name.toLowerCase() === name.toLowerCase()) || null
  }

  /**
   * Get all party IDs
   * @returns {Array<string>}
   */
  getIds() {
    return this.parties.map((p) => p.id)
  }

  /**
   * Check if party exists
   * @param {string} partyId
   * @returns {boolean}
   */
  exists(partyId) {
    return this.parties.some((p) => p.id === partyId)
  }

  /* -------------------------------------------- */
  /*  Selection                                   */
  /* -------------------------------------------- */

  /**
   * Select a party
   * @param {string|null} partyId
   * @returns {boolean}
   */
  select(partyId) {
    if (partyId && !this.exists(partyId)) {
      console.warn('[useParties] Cannot select: party not found')
      return false
    }

    this.selectedId = partyId
    return true
  }

  /**
   * Clear selection
   */
  clearSelection() {
    this.selectedId = null
  }

  /* -------------------------------------------- */
  /*  API Operations                              */
  /* -------------------------------------------- */

  /**
   * Fetch full party details including members
   * @param {string} partyId
   * @returns {Promise<object|null>}
   */
  async fetchPartyDetails(partyId) {
    const api = window.CritFumbleCore?.apiClient
    if (!api) return null

    try {
      const response = await api.getParty(this.campaignId, partyId)
      const party = response.party || response

      // Update local cache
      const index = this.parties.findIndex((p) => p.id === partyId)
      if (index >= 0) {
        this.parties[index] = party
      }

      return party
    } catch (error) {
      console.error('[useParties] Fetch party details failed:', error)
      return null
    }
  }

  /**
   * Get members for a party
   * @param {string} partyId
   * @returns {Promise<Array>}
   */
  async fetchMembers(partyId) {
    const api = window.CritFumbleCore?.apiClient
    if (!api) return []

    try {
      const response = await api.getPartyMembers(this.campaignId, partyId)
      return response.members || []
    } catch (error) {
      console.error('[useParties] Fetch members failed:', error)
      return []
    }
  }

  /**
   * Create a new party
   * @param {object} partyData - { name, description, color }
   * @returns {Promise<object|null>} Created party
   */
  async create(partyData) {
    const api = window.CritFumbleCore?.apiClient
    if (!api) return null

    try {
      const response = await api.createParty(this.campaignId, partyData)
      const party = response.party || response

      this.parties.push(party)
      return party
    } catch (error) {
      console.error('[useParties] Create party failed:', error)
      return null
    }
  }

  /**
   * Update a party
   * @param {string} partyId
   * @param {object} partyData
   * @returns {Promise<object|null>} Updated party
   */
  async update(partyId, partyData) {
    const api = window.CritFumbleCore?.apiClient
    if (!api) return null

    try {
      const response = await api.updateParty(this.campaignId, partyId, partyData)
      const party = response.party || response

      // Update local cache
      const index = this.parties.findIndex((p) => p.id === partyId)
      if (index >= 0) {
        this.parties[index] = party
      }

      return party
    } catch (error) {
      console.error('[useParties] Update party failed:', error)
      return null
    }
  }

  /**
   * Delete a party
   * @param {string} partyId
   * @returns {Promise<boolean>}
   */
  async delete(partyId) {
    const api = window.CritFumbleCore?.apiClient
    if (!api) return false

    try {
      await api.deleteParty(this.campaignId, partyId)

      // Remove from local cache
      const index = this.parties.findIndex((p) => p.id === partyId)
      if (index >= 0) {
        this.parties.splice(index, 1)
      }

      // Clear selection if deleted party was selected
      if (this.selectedId === partyId) {
        this.selectedId = null
      }

      return true
    } catch (error) {
      console.error('[useParties] Delete party failed:', error)
      return false
    }
  }

  /**
   * Add a member to a party
   * @param {string} partyId
   * @param {string} playerId
   * @param {Array<string>} roles
   * @returns {Promise<object|null>} Created membership
   */
  async addMember(partyId, playerId, roles = []) {
    const api = window.CritFumbleCore?.apiClient
    if (!api) return null

    try {
      const response = await api.addPartyMember(this.campaignId, partyId, playerId, roles)
      return response.member || response
    } catch (error) {
      console.error('[useParties] Add member failed:', error)
      return null
    }
  }

  /**
   * Remove a member from a party
   * @param {string} partyId
   * @param {string} memberId
   * @returns {Promise<boolean>}
   */
  async removeMember(partyId, memberId) {
    const api = window.CritFumbleCore?.apiClient
    if (!api) return false

    try {
      await api.removePartyMember(this.campaignId, partyId, memberId)
      return true
    } catch (error) {
      console.error('[useParties] Remove member failed:', error)
      return false
    }
  }

  /* -------------------------------------------- */
  /*  Utility Methods                             */
  /* -------------------------------------------- */

  /**
   * Change the campaign this hook is managing
   * @param {string} campaignId
   * @returns {Promise<useParties>}
   */
  async setCampaign(campaignId) {
    this.campaignId = campaignId
    this.selectedId = null
    this.parties = []
    return this.load()
  }

  /**
   * Get parties sorted by name
   * @returns {Array}
   */
  getSortedByName() {
    return [...this.parties].sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * Get parties with member count
   * @returns {Array<{party: object, memberCount: number}>}
   */
  getWithMemberCount() {
    return this.parties.map((party) => ({
      party,
      memberCount: party.members?.length || 0,
    }))
  }
}
