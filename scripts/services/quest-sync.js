/**
 * Quest Sync Manager
 * Synchronizes campaign quest log with Foundry journal entries
 */

export class QuestSyncManager {
  constructor(apiClient, partyContext) {
    this.apiClient = apiClient
    this.partyContext = partyContext
    this.questFolder = null
    this.quests = []
  }

  /**
   * Initialize quest sync on world ready
   */
  async initialize() {
    const campaignId = game.settings.get('crit-fumble-core', 'campaignId')

    if (!campaignId) {
      console.log('[Quest Sync] No linked campaign - skipping quest sync')
      return
    }

    try {
      await this.ensureQuestFolder()
      await this.syncQuests(campaignId)

      console.log(`[Quest Sync] Synced ${this.quests.length} quests to journal`)
    } catch (error) {
      console.error('[Quest Sync] Failed to sync quests:', error)
      ui.notifications.warn('Could not sync quest log')
    }
  }

  /**
   * Ensure quest folder exists in journal
   */
  async ensureQuestFolder() {
    // Find existing quest folder
    this.questFolder = game.folders.find((f) => f.type === 'JournalEntry' && f.name === 'Quest Log')

    // Create if doesn't exist
    if (!this.questFolder) {
      this.questFolder = await Folder.create({
        name: 'Quest Log',
        type: 'JournalEntry',
        color: '#FFD700',
        sorting: 'a',
      })
    }
  }

  /**
   * Sync quests from Core API to Foundry journals
   * @param {string} campaignId - Campaign ID
   */
  async syncQuests(campaignId) {
    const partyId = this.partyContext?.getActivePartyId() ?? undefined

    // Get quests visible to this party (shared + party-specific)
    const data = await this.apiClient.getQuests(campaignId, {
      partyId,
      includeShared: true,
    })

    this.quests = data.quests || []

    // Sync each quest to journal
    for (const quest of this.quests) {
      await this.syncQuestToJournal(quest)
    }

    // Remove journals for deleted quests
    await this.cleanupDeletedQuests()
  }

  /**
   * Sync a single quest to a journal entry
   * @param {object} quest - Quest data from API
   */
  async syncQuestToJournal(quest) {
    const journalName = `[${quest.status.toUpperCase()}] ${quest.name}`

    // Find existing journal
    let journal = game.journal.find((j) => j.flags?.critFumble?.questId === quest.id)

    // Build journal content
    const content = this.buildQuestContent(quest)

    const journalData = {
      name: journalName,
      folder: this.questFolder?.id,
      flags: {
        critFumble: {
          questId: quest.id,
          questSlug: quest.slug,
          isQuest: true,
          questStatus: quest.status,
          isShared: quest.isShared,
          partyId: quest.party?.id || null,
        },
      },
      pages: [
        {
          name: quest.name,
          type: 'text',
          text: {
            content,
            format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML,
          },
        },
      ],
    }

    if (journal) {
      // Update existing journal
      await journal.update(journalData)
    } else {
      // Create new journal
      journal = await JournalEntry.create(journalData)
    }

    // Set permissions based on quest visibility
    const permission = this.getQuestPermissions(quest)
    await journal.update({ ownership: permission })
  }

  /**
   * Build HTML content for quest journal
   * @param {object} quest - Quest data
   * @returns {string} HTML content
   */
  buildQuestContent(quest) {
    const partyColor = this.partyContext?.getPartyColor() ?? '#4a90d9'

    let html = `
      <div style="font-family: 'Signika', sans-serif;">
        <!-- Header -->
        <div style="background: ${quest.isShared ? '#4A90E2' : partyColor}; color: white; padding: 12px; margin: -8px -8px 16px -8px; border-radius: 4px;">
          <h2 style="margin: 0; color: white;">
            ${quest.isShared ? '<i class="fas fa-globe"></i>' : '<i class="fas fa-users"></i>'}
            ${quest.name}
          </h2>
          ${quest.party ? `<small style="opacity: 0.9;">Party Quest: ${quest.party.name}</small>` : '<small style="opacity: 0.9;">Shared Quest</small>'}
        </div>

        <!-- Description -->
        ${
          quest.description
            ? `
          <div style="font-style: italic; color: #666; margin-bottom: 16px;">
            ${quest.description}
          </div>
        `
            : ''
        }

        <!-- Status -->
        <div style="margin: 16px 0;">
          <strong>Status:</strong>
          <span style="
            display: inline-block;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: bold;
            ${this.getStatusStyle(quest.status)}
          ">
            ${quest.status.toUpperCase()}
          </span>
        </div>

        <!-- Objectives -->
        ${
          quest.objectives && quest.objectives.length > 0
            ? `
          <div style="margin: 16px 0;">
            <h3 style="margin-bottom: 8px;">Objectives:</h3>
            <ul style="margin: 0; padding-left: 24px;">
              ${quest.objectives
                .map(
                  (obj) => `
                <li style="${obj.completed ? 'text-decoration: line-through; color: #999;' : ''}">
                  ${obj.completed ? '<i class="fas fa-check-square" style="color: #0a0;"></i>' : '<i class="far fa-square"></i>'}
                  ${obj.description}
                </li>
              `,
                )
                .join('')}
            </ul>
          </div>
        `
            : ''
        }

        <!-- Progress (for shared quests) -->
        ${
          quest.isShared && quest.progress && Object.keys(quest.progress).length > 0
            ? `
          <div style="margin: 16px 0;">
            <h3 style="margin-bottom: 8px;">Party Progress:</h3>
            ${Object.entries(quest.progress)
              .map(
                ([partyId, percent]) => `
              <div style="margin: 8px 0;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                  <span>Party</span>
                  <span>${percent}%</span>
                </div>
                <div style="width: 100%; background: #ddd; height: 20px; border-radius: 10px; overflow: hidden;">
                  <div style="width: ${percent}%; background: ${partyColor}; height: 100%;"></div>
                </div>
              </div>
            `,
              )
              .join('')}
          </div>
        `
            : ''
        }

        <!-- Rewards -->
        ${
          quest.rewards && Object.keys(quest.rewards).length > 0
            ? `
          <div style="margin: 16px 0; padding: 12px; background: #f9f9f9; border-left: 4px solid #FFD700; border-radius: 4px;">
            <h3 style="margin-top: 0;">Rewards:</h3>
            <ul style="margin: 0; padding-left: 24px;">
              ${quest.rewards.gold ? `<li><i class="fas fa-coins"></i> ${quest.rewards.gold.toLocaleString()} GP</li>` : ''}
              ${quest.rewards.xp ? `<li><i class="fas fa-star"></i> ${quest.rewards.xp.toLocaleString()} XP</li>` : ''}
              ${quest.rewards.reputation ? `<li><i class="fas fa-heart"></i> +${quest.rewards.reputation} Reputation</li>` : ''}
              ${quest.rewards.items ? quest.rewards.items.map((item) => `<li><i class="fas fa-gift"></i> ${item}</li>`).join('') : ''}
            </ul>
          </div>
        `
            : ''
        }

        <!-- Tags -->
        ${
          quest.tags && quest.tags.length > 0
            ? `
          <div style="margin: 16px 0;">
            <strong>Tags:</strong>
            ${quest.tags
              .map(
                (tag) => `
              <span style="display: inline-block; background: #e0e0e0; padding: 2px 8px; margin: 2px; border-radius: 4px; font-size: 11px;">
                ${tag}
              </span>
            `,
              )
              .join('')}
          </div>
        `
            : ''
        }

        <!-- Footer -->
        <div style="margin-top: 24px; padding-top: 12px; border-top: 1px solid #ddd; font-size: 12px; color: #999;">
          <em>Last updated: ${new Date(quest.updatedAt).toLocaleString()}</em>
        </div>
      </div>
    `

    return html
  }

  /**
   * Get status badge styling
   * @param {string} status - Quest status
   * @returns {string} CSS styles
   */
  getStatusStyle(status) {
    switch (status) {
      case 'active':
        return 'background: #4CAF50; color: white;'
      case 'completed':
        return 'background: #2196F3; color: white;'
      case 'failed':
        return 'background: #F44336; color: white;'
      default:
        return 'background: #999; color: white;'
    }
  }

  /**
   * Get permissions for quest journal
   * @param {object} quest - Quest data
   * @returns {object} Foundry ownership object
   */
  getQuestPermissions(quest) {
    const permissions = {
      default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER, // Everyone can read
    }

    // GMs get owner permission
    for (const user of game.users) {
      if (user.isGM) {
        permissions[user.id] = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER
      }
    }

    // If party-specific quest, only party members get owner (can edit)
    if (!quest.isShared && quest.party && this.partyContext?.activeParty) {
      for (const member of this.partyContext.activeParty.members) {
        const foundryUser = game.users.find((u) => u.flags?.critFumble?.userId === member.userId)
        if (foundryUser) {
          permissions[foundryUser.id] = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER
        }
      }
    }

    return permissions
  }

  /**
   * Cleanup journals for deleted quests
   */
  async cleanupDeletedQuests() {
    const questIds = new Set(this.quests.map((q) => q.id))

    // Find quest journals that no longer exist in API
    const orphanedJournals = game.journal.filter(
      (j) => j.flags?.critFumble?.isQuest && !questIds.has(j.flags.critFumble.questId),
    )

    // Delete orphaned journals
    for (const journal of orphanedJournals) {
      await journal.delete()
      console.log(`[Quest Sync] Removed orphaned quest journal: ${journal.name}`)
    }
  }

  /**
   * Manually refresh quest log
   */
  async refresh() {
    const campaignId = game.settings.get('crit-fumble-core', 'campaignId')
    if (campaignId) {
      await this.syncQuests(campaignId)
      ui.notifications.info('Quest log refreshed')
    }
  }

  /**
   * Update quest status from Foundry
   * @param {string} questId - Quest ID
   * @param {string} status - New status
   */
  async updateQuestStatus(questId, status) {
    const campaignId = game.settings.get('crit-fumble-core', 'campaignId')

    if (!campaignId) {
      ui.notifications.error('No linked campaign')
      return
    }

    try {
      await this.apiClient.updateQuest(campaignId, questId, { status })
      await this.refresh()
      ui.notifications.info(`Quest marked as ${status}`)
    } catch (error) {
      console.error('[Quest Sync] Failed to update quest:', error)
      ui.notifications.error('Failed to update quest')
    }
  }

  /**
   * Mark quest as completed (convenience method for GMs)
   * @param {string} questId - Quest ID
   */
  async completeQuest(questId) {
    await this.updateQuestStatus(questId, 'completed')
  }

  /**
   * Mark quest as failed (convenience method for GMs)
   * @param {string} questId - Quest ID
   */
  async failQuest(questId) {
    await this.updateQuestStatus(questId, 'failed')
  }
}
