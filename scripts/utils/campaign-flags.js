/**
 * Campaign Flags Helper
 * Utilities for managing campaign associations on FoundryVTT documents
 *
 * Flag structure (namespace: 'crit-fumble-core'):
 * {
 *   campaigns: [
 *     { campaignId: 'clxyz123', partyId: 'clxyz456', role: 'shared', addedAt: timestamp }
 *   ],
 *   playerId: 'clxyz789',  // For actors - Core API player ID
 *   userId: 'abc123'       // For actors - Core API user ID
 * }
 */

export const CAMPAIGN_FLAG_NAMESPACE = 'crit-fumble-core'

export class CampaignFlags {
  /* -------------------------------------------- */
  /*  Campaign Associations                       */
  /* -------------------------------------------- */

  /**
   * Get campaigns associated with a document
   * @param {Document} document - FoundryVTT document (Actor, Scene, Item, JournalEntry)
   * @returns {Array} Array of campaign associations
   */
  static getCampaigns(document) {
    if (!document?.getFlag) return []
    return document.getFlag(CAMPAIGN_FLAG_NAMESPACE, 'campaigns') || []
  }

  /**
   * Check if document belongs to a specific campaign
   * @param {Document} document - FoundryVTT document
   * @param {string} campaignId - Campaign ID to check
   * @returns {boolean}
   */
  static belongsToCampaign(document, campaignId) {
    const campaigns = this.getCampaigns(document)
    return campaigns.some((c) => c.campaignId === campaignId)
  }

  /**
   * Check if document belongs to a specific party
   * @param {Document} document - FoundryVTT document
   * @param {string} partyId - Party ID to check
   * @returns {boolean}
   */
  static belongsToParty(document, partyId) {
    const campaigns = this.getCampaigns(document)
    return campaigns.some((c) => c.partyId === partyId)
  }

  /**
   * Get campaign association for a specific campaign
   * @param {Document} document - FoundryVTT document
   * @param {string} campaignId - Campaign ID
   * @returns {object|null} Campaign association or null
   */
  static getCampaignAssociation(document, campaignId) {
    const campaigns = this.getCampaigns(document)
    return campaigns.find((c) => c.campaignId === campaignId) || null
  }

  /**
   * Add document to a campaign
   * @param {Document} document - FoundryVTT document
   * @param {string} campaignId - Campaign ID to add
   * @param {object} options - Association options
   * @param {string} [options.partyId] - Optional party ID
   * @param {string} [options.role='shared'] - Role: 'shared' | 'campaign-only' | 'party-only'
   * @returns {Promise<boolean>} True if added, false if already in campaign
   */
  static async addToCampaign(document, campaignId, options = {}) {
    if (!document?.setFlag) {
      console.warn('[CFG Campaign Flags] Cannot set flag on document:', document)
      return false
    }

    const campaigns = this.getCampaigns(document)

    // Check if already in campaign
    const existingIndex = campaigns.findIndex((c) => c.campaignId === campaignId)
    if (existingIndex >= 0) {
      // Update existing association if options changed
      if (options.partyId || options.role) {
        campaigns[existingIndex] = {
          ...campaigns[existingIndex],
          partyId: options.partyId ?? campaigns[existingIndex].partyId,
          role: options.role ?? campaigns[existingIndex].role,
        }
        await document.setFlag(CAMPAIGN_FLAG_NAMESPACE, 'campaigns', campaigns)
        return true
      }
      return false // Already in campaign, no changes
    }

    // Add new association
    campaigns.push({
      campaignId,
      partyId: options.partyId || null,
      role: options.role || 'shared',
      addedAt: Date.now(),
    })

    await document.setFlag(CAMPAIGN_FLAG_NAMESPACE, 'campaigns', campaigns)
    return true
  }

  /**
   * Remove document from a campaign
   * @param {Document} document - FoundryVTT document
   * @param {string} campaignId - Campaign ID to remove
   * @returns {Promise<boolean>} True if removed, false if not in campaign
   */
  static async removeFromCampaign(document, campaignId) {
    if (!document?.setFlag) return false

    const campaigns = this.getCampaigns(document)
    const filtered = campaigns.filter((c) => c.campaignId !== campaignId)

    if (filtered.length === campaigns.length) {
      return false // Campaign not found
    }

    await document.setFlag(CAMPAIGN_FLAG_NAMESPACE, 'campaigns', filtered)
    return true
  }

  /**
   * Update party assignment for a campaign
   * @param {Document} document - FoundryVTT document
   * @param {string} campaignId - Campaign ID
   * @param {string|null} partyId - New party ID (null to clear)
   * @returns {Promise<boolean>} True if updated
   */
  static async setParty(document, campaignId, partyId) {
    if (!document?.setFlag) return false

    const campaigns = this.getCampaigns(document)
    const index = campaigns.findIndex((c) => c.campaignId === campaignId)

    if (index < 0) {
      return false // Not in campaign
    }

    campaigns[index].partyId = partyId
    await document.setFlag(CAMPAIGN_FLAG_NAMESPACE, 'campaigns', campaigns)
    return true
  }

  /**
   * Clear all campaign associations from a document
   * @param {Document} document - FoundryVTT document
   * @returns {Promise<boolean>}
   */
  static async clearCampaigns(document) {
    if (!document?.setFlag) return false
    await document.setFlag(CAMPAIGN_FLAG_NAMESPACE, 'campaigns', [])
    return true
  }

  /* -------------------------------------------- */
  /*  Player Associations (Actors only)           */
  /* -------------------------------------------- */

  /**
   * Set player association for an actor
   * @param {Actor} actor - FoundryVTT actor
   * @param {string} playerId - Core API player ID
   * @param {string} userId - Core API user ID
   * @returns {Promise<boolean>}
   */
  static async setPlayer(actor, playerId, userId) {
    if (!actor?.setFlag) return false

    await actor.setFlag(CAMPAIGN_FLAG_NAMESPACE, 'playerId', playerId)
    await actor.setFlag(CAMPAIGN_FLAG_NAMESPACE, 'userId', userId)
    return true
  }

  /**
   * Get player ID for an actor
   * @param {Actor} actor - FoundryVTT actor
   * @returns {string|null}
   */
  static getPlayerId(actor) {
    if (!actor?.getFlag) return null
    return actor.getFlag(CAMPAIGN_FLAG_NAMESPACE, 'playerId') || null
  }

  /**
   * Get user ID for an actor
   * @param {Actor} actor - FoundryVTT actor
   * @returns {string|null}
   */
  static getUserId(actor) {
    if (!actor?.getFlag) return null
    return actor.getFlag(CAMPAIGN_FLAG_NAMESPACE, 'userId') || null
  }

  /**
   * Clear player association from an actor
   * @param {Actor} actor - FoundryVTT actor
   * @returns {Promise<boolean>}
   */
  static async clearPlayer(actor) {
    if (!actor?.setFlag) return false

    await actor.unsetFlag(CAMPAIGN_FLAG_NAMESPACE, 'playerId')
    await actor.unsetFlag(CAMPAIGN_FLAG_NAMESPACE, 'userId')
    return true
  }

  /* -------------------------------------------- */
  /*  Query Helpers                               */
  /* -------------------------------------------- */

  /**
   * Find actors associated with a specific player
   * @param {string} playerId - Core API player ID
   * @returns {Array<Actor>}
   */
  static findActorsByPlayer(playerId) {
    return game.actors.filter((actor) => this.getPlayerId(actor) === playerId)
  }

  /**
   * Find documents in a specific campaign
   * @param {Collection} collection - FoundryVTT collection (game.actors, game.scenes, etc.)
   * @param {string} campaignId - Campaign ID
   * @returns {Array<Document>}
   */
  static findByCampaign(collection, campaignId) {
    return collection.filter((doc) => this.belongsToCampaign(doc, campaignId))
  }

  /**
   * Find documents in a specific party
   * @param {Collection} collection - FoundryVTT collection
   * @param {string} partyId - Party ID
   * @returns {Array<Document>}
   */
  static findByParty(collection, partyId) {
    return collection.filter((doc) => this.belongsToParty(doc, partyId))
  }

  /**
   * Get documents that have no campaign associations (unassigned)
   * @param {Collection} collection - FoundryVTT collection
   * @returns {Array<Document>}
   */
  static findUnassigned(collection) {
    return collection.filter((doc) => this.getCampaigns(doc).length === 0)
  }

  /**
   * Get filtered documents for active campaign
   * Documents with no campaigns show in all campaigns
   * @param {Collection} collection - FoundryVTT collection
   * @param {string|null} activeCampaignId - Active campaign ID (null = show all)
   * @returns {Array<Document>}
   */
  static getFiltered(collection, activeCampaignId) {
    if (!activeCampaignId) {
      return collection.contents
    }

    return collection.filter((doc) => {
      const campaigns = this.getCampaigns(doc)
      // Show if: no campaign associations OR belongs to active campaign
      return campaigns.length === 0 || campaigns.some((c) => c.campaignId === activeCampaignId)
    })
  }

  /* -------------------------------------------- */
  /*  Batch Operations                            */
  /* -------------------------------------------- */

  /**
   * Add multiple documents to a campaign
   * @param {Array<Document>} documents - Array of documents
   * @param {string} campaignId - Campaign ID
   * @param {object} options - Association options
   * @returns {Promise<number>} Number of documents added
   */
  static async addManyToCampaign(documents, campaignId, options = {}) {
    let count = 0
    for (const doc of documents) {
      const added = await this.addToCampaign(doc, campaignId, options)
      if (added) count++
    }
    return count
  }

  /**
   * Remove multiple documents from a campaign
   * @param {Array<Document>} documents - Array of documents
   * @param {string} campaignId - Campaign ID
   * @returns {Promise<number>} Number of documents removed
   */
  static async removeManyFromCampaign(documents, campaignId) {
    let count = 0
    for (const doc of documents) {
      const removed = await this.removeFromCampaign(doc, campaignId)
      if (removed) count++
    }
    return count
  }
}
