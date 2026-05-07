/**
 * Party Context Manager
 * Loads and displays active party context for multi-party campaigns
 */

export class PartyContextManager {
  constructor(apiClient) {
    this.apiClient = apiClient
    this.activeParty = null
    this.activeSession = null
    this.bannerElement = null
  }

  /**
   * Initialize party context on world ready
   */
  async initialize() {
    const worldId = game.settings.get('crit-fumble-core', 'linkedWorldId')

    if (!worldId) {
      console.log('[Party Context] No linked world ID - skipping party context')
      return
    }

    try {
      await this.loadActiveParty(worldId)

      if (this.activeParty) {
        this.displayPartyBanner()
        this.updateGameSettings()
        ui.notifications.info(`Active Party: ${this.activeParty.name}`)

        console.log('[Party Context] Loaded:', {
          party: this.activeParty.name,
          members: this.activeParty.memberCount,
          color: this.activeParty.color,
          session: this.activeSession?.name,
        })
      } else {
        console.log('[Party Context] No active party for this world')
      }
    } catch (error) {
      console.error('[Party Context] Failed to load active party:', error)
      ui.notifications.warn('Could not load active party info')
    }
  }

  /**
   * Load active party from Core API
   * @param {string} worldId - World ID
   */
  async loadActiveParty(worldId) {
    const data = await this.apiClient.getActiveParty(worldId)

    this.activeParty = data.activeParty || null
    this.activeSession = data.activeSession || null

    // Store in game settings for other modules to access
    game.settings.set('crit-fumble-core', 'activePartyId', this.activeParty?.id || null)
    game.settings.set('crit-fumble-core', 'activePartyName', this.activeParty?.name || null)
    game.settings.set('crit-fumble-core', 'activePartyColor', this.activeParty?.color || null)
  }

  /**
   * Display party banner in UI
   */
  displayPartyBanner() {
    if (!this.activeParty) return

    // Remove existing banner
    if (this.bannerElement) {
      this.bannerElement.remove()
    }

    // Create party banner
    const banner = document.createElement('div')
    banner.id = 'party-context-banner'
    banner.style.cssText = `
      position: fixed;
      top: 10px;
      right: 10px;
      background: ${this.activeParty.color || '#8B0000'};
      color: white;
      padding: 8px 16px;
      border-radius: 4px;
      font-family: 'Signika', sans-serif;
      font-size: 14px;
      font-weight: bold;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      z-index: 100;
      cursor: pointer;
      transition: all 0.2s;
    `

    const bannerContent = document.createElement('div')
    bannerContent.style.cssText = 'display: flex; align-items: center; gap: 8px;'

    const usersIcon = document.createElement('i')
    usersIcon.className = 'fas fa-users'
    bannerContent.appendChild(usersIcon)

    const partyName = document.createElement('span')
    partyName.textContent = this.activeParty.name
    bannerContent.appendChild(partyName)

    if (this.activeSession) {
      const sessionIndicator = document.createElement('i')
      sessionIndicator.className = 'fas fa-circle'
      sessionIndicator.style.cssText = 'font-size: 6px; color: #0f0;'
      sessionIndicator.title = 'Session Active'
      bannerContent.appendChild(sessionIndicator)
    }

    banner.appendChild(bannerContent)

    // Hover effect
    banner.addEventListener('mouseenter', () => {
      banner.style.transform = 'scale(1.05)'
    })

    banner.addEventListener('mouseleave', () => {
      banner.style.transform = 'scale(1)'
    })

    // Click to show party details
    banner.addEventListener('click', () => {
      this.showPartyDetails()
    })

    document.body.appendChild(banner)
    this.bannerElement = banner
  }

  /**
   * Show party details dialog
   */
  showPartyDetails() {
    if (!this.activeParty) return

    const content = `
      <div style="font-family: 'Signika', sans-serif;">
        <h3 style="color: ${this.activeParty.color}; margin-top: 0;">
          <i class="fas fa-users"></i> ${this.activeParty.name}
        </h3>

        ${
          this.activeParty.description
            ? `
          <p style="font-style: italic; color: #666;">
            ${this.activeParty.description}
          </p>
        `
            : ''
        }

        <div style="margin: 16px 0;">
          <strong>Members:</strong> ${this.activeParty.memberCount}
        </div>

        ${
          this.activeParty.members && this.activeParty.members.length > 0
            ? `
          <div style="margin: 8px 0;">
            <strong>Party Members:</strong>
            <ul style="margin: 8px 0; padding-left: 20px;">
              ${this.activeParty.members
                .map(
                  (m) => `
                <li>${m.userName} ${m.roles.includes('dm') ? '<span style="color: gold;">(DM)</span>' : ''}</li>
              `,
                )
                .join('')}
            </ul>
          </div>
        `
            : ''
        }

        ${
          this.activeSession
            ? `
          <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid #ccc;">
            <strong>Active Session:</strong> ${this.activeSession.name}<br>
            <small style="color: #666;">
              Started: ${new Date(this.activeSession.startedAt).toLocaleString()}
            </small>
          </div>
        `
            : ''
        }
      </div>
    `

    new Dialog({
      title: `Party: ${this.activeParty.name}`,
      content,
      buttons: {
        close: {
          icon: '<i class="fas fa-times"></i>',
          label: 'Close',
        },
      },
      default: 'close',
    }).render(true)
  }

  /**
   * Update game settings with party context
   */
  updateGameSettings() {
    if (!this.activeParty) return

    // Set party context in game data for other modules to use
    game.cfPartyContext = {
      party: this.activeParty,
      session: this.activeSession,
      isActive: !!this.activeSession,
    }
  }

  /**
   * Refresh active party (call this when session changes)
   */
  async refresh() {
    const worldId = game.settings.get('crit-fumble-core', 'linkedWorldId')
    if (worldId) {
      await this.initialize()
    }
  }

  /**
   * Clear party context (when session ends)
   */
  clear() {
    this.activeParty = null
    this.activeSession = null

    if (this.bannerElement) {
      this.bannerElement.remove()
      this.bannerElement = null
    }

    game.settings.set('crit-fumble-core', 'activePartyId', null)
    game.settings.set('crit-fumble-core', 'activePartyName', null)
    game.settings.set('crit-fumble-core', 'activePartyColor', null)

    delete game.cfPartyContext
  }

  /**
   * Get current active party ID (for filtering content)
   * @returns {string|null}
   */
  getActivePartyId() {
    return this.activeParty?.id || null
  }

  /**
   * Check if a party member is currently active
   * @param {string} userId - User ID to check
   * @returns {boolean}
   */
  isPartyMember(userId) {
    if (!this.activeParty?.members) return false
    return this.activeParty.members.some((m) => m.userId === userId)
  }

  /**
   * Get party color for UI theming
   * @returns {string}
   */
  getPartyColor() {
    return this.activeParty?.color || '#8B0000'
  }
}
