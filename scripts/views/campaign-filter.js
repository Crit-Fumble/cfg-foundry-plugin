/**
 * Campaign Filter
 * Filters sidebar content based on active campaign
 */

import { CampaignFlags } from '../utils/campaign-flags.js'

const MODULE_ID = 'crit-fumble-core'

export class CampaignFilter {
  /**
   * Register all sidebar filter hooks
   */
  static registerHooks() {
    // Filter directory rendering
    Hooks.on('renderActorDirectory', CampaignFilter.onRenderDirectory)
    Hooks.on('renderItemDirectory', CampaignFilter.onRenderDirectory)
    Hooks.on('renderJournalDirectory', CampaignFilter.onRenderDirectory)
    Hooks.on('renderSceneDirectory', CampaignFilter.onRenderDirectory)

    // Add campaign switcher to sidebar
    Hooks.on('renderSidebar', CampaignFilter.onRenderSidebar)

    console.log('[CFG Campaign Filter] Hooks registered')
  }

  /**
   * Hook handler for directory rendering
   * @param {Application} app - Directory application
   * @param {jQuery|HTMLElement} html - Rendered HTML (jQuery in v12, DOM element in v13)
   * @param {object} data - Render data
   */
  static onRenderDirectory(app, html, data) {
    // Foundry v13: html may be DOM element or jQuery
    const $html = html instanceof HTMLElement ? $(html) : html

    const filterMode = game.settings.get(MODULE_ID, 'campaignFilterMode')

    // Add filter indicator regardless of mode
    CampaignFilter._addFilterIndicator(app, $html)

    if (filterMode === 'all') {
      // No filtering, show everything
      return
    }

    const activeCampaignId = game.settings.get(MODULE_ID, 'activeCampaignId')

    if (!activeCampaignId) {
      // No active campaign, show everything
      return
    }

    // Get the document collection
    const documentName = app.constructor.documentName
    const collection = game[documentName.toLowerCase() + 's']

    if (!collection) return

    // Filter visible entries
    const entries = $html.find('.directory-item[data-document-id], .directory-item[data-entry-id]')

    entries.each((i, entry) => {
      const entryId = entry.dataset.documentId || entry.dataset.entryId
      const document = collection.get(entryId)

      if (!document) return

      const campaigns = CampaignFlags.getCampaigns(document)
      const hasNoCampaigns = campaigns.length === 0
      const belongsToActive = CampaignFlags.belongsToCampaign(document, activeCampaignId)

      // Show if: belongs to active campaign OR has no campaign associations (unassigned)
      const shouldShow = belongsToActive || hasNoCampaigns

      if (!shouldShow) {
        $(entry).addClass('cfg-filtered-out')
        // Use CSS to hide rather than removing from DOM
      }
    })

    // Update folder counts
    CampaignFilter._updateFolderCounts($html)
  }

  /**
   * Add filter indicator to directory header
   */
  static _addFilterIndicator(app, html) {
    const header = html.find('.directory-header')
    if (!header.length) return

    // Remove existing indicator
    header.find('.cfg-campaign-filter-indicator').remove()

    const filterMode = game.settings.get(MODULE_ID, 'campaignFilterMode')
    const activeCampaignId = game.settings.get(MODULE_ID, 'activeCampaignId')
    const linkedCampaigns = game.settings.get(MODULE_ID, 'linkedCampaigns') || []

    // Don't show indicator if no campaigns linked
    if (linkedCampaigns.length === 0) return

    let indicatorText = 'All Content'
    let indicatorClass = ''
    let indicatorTitle = 'Click to open Campaign Manager'

    if (filterMode !== 'all' && activeCampaignId) {
      const campaign = linkedCampaigns.find((c) => c.campaignId === activeCampaignId)
      indicatorText = campaign?.name || 'Active Campaign'
      indicatorClass = 'active'
      indicatorTitle = `Filtering by: ${indicatorText}. Click to manage.`
    }

    const indicator = $(`
      <div class="cfg-campaign-filter-indicator ${indicatorClass}" title="${indicatorTitle}">
        <i class="fas fa-filter"></i>
        <span class="cfg-indicator-text">${indicatorText}</span>
      </div>
    `)

    indicator.on('click', () => {
      window.CritFumbleCore?.openCampaignManager?.()
    })

    // Insert after the search bar or at the end of header
    const searchBar = header.find('.header-search')
    if (searchBar.length) {
      searchBar.after(indicator)
    } else {
      header.append(indicator)
    }
  }

  /**
   * Update folder counts after filtering
   */
  static _updateFolderCounts(html) {
    const folders = html.find('.folder')

    folders.each((i, folder) => {
      const $folder = $(folder)
      const visibleChildren = $folder.find('.directory-item:not(.cfg-filtered-out)').length
      const countEl = $folder.find('.folder-count')

      if (countEl.length) {
        // Store original count if not already stored
        if (!countEl.data('originalCount')) {
          countEl.data('originalCount', countEl.text())
        }

        countEl.text(`${visibleChildren}`)

        // Hide folder if no visible children
        if (visibleChildren === 0) {
          $folder.addClass('cfg-filtered-out')
        }
      }
    })
  }

  /**
   * Add campaign switcher to sidebar (when multiple campaigns)
   */
  static onRenderSidebar(sidebar, html) {
    // Only for GMs
    if (!game.user.isGM) return

    const linkedCampaigns = game.settings.get(MODULE_ID, 'linkedCampaigns') || []

    // Don't show switcher if less than 2 campaigns
    if (linkedCampaigns.length < 2) return

    // Remove existing switcher
    html.find('.cfg-campaign-switcher').remove()

    const activeCampaignId = game.settings.get(MODULE_ID, 'activeCampaignId')

    const switcher = $(`
      <div class="cfg-campaign-switcher">
        <label class="cfg-switcher-label">
          <i class="fas fa-filter"></i> Campaign:
        </label>
        <select class="cfg-switcher-select" id="cfg-active-campaign">
          <option value="">All Campaigns</option>
          ${linkedCampaigns
            .map(
              (c) => `
            <option value="${c.campaignId}" ${c.campaignId === activeCampaignId ? 'selected' : ''}>
              ${c.name}
            </option>
          `,
            )
            .join('')}
        </select>
      </div>
    `)

    switcher.find('select').on('change', async (e) => {
      const campaignId = e.target.value
      await game.settings.set(MODULE_ID, 'activeCampaignId', campaignId)

      // Re-render all directories
      ui.actors?.render()
      ui.items?.render()
      ui.journal?.render()
      ui.scenes?.render()

      const campaign = linkedCampaigns.find((c) => c.campaignId === campaignId)
      ui.notifications.info(campaignId ? `Campaign filter: ${campaign?.name}` : 'Showing all campaigns')
    })

    // Insert after sidebar tabs
    const tabs = html.find('#sidebar-tabs')
    if (tabs.length) {
      tabs.after(switcher)
    }
  }

  /**
   * Get filtered documents for a collection
   * @param {Collection} collection - FoundryVTT collection
   * @param {string|null} campaignId - Campaign ID (null uses active)
   * @returns {Array<Document>}
   */
  static getFilteredDocuments(collection, campaignId = null) {
    const filterMode = game.settings.get(MODULE_ID, 'campaignFilterMode')

    if (filterMode === 'all') {
      return collection.contents
    }

    const activeCampaignId = campaignId || game.settings.get(MODULE_ID, 'activeCampaignId')

    if (!activeCampaignId) {
      return collection.contents
    }

    return collection.contents.filter((doc) => {
      const campaigns = CampaignFlags.getCampaigns(doc)
      // Show if: no campaign associations OR belongs to active campaign
      return campaigns.length === 0 || campaigns.some((c) => c.campaignId === activeCampaignId)
    })
  }

  /**
   * Check if a document should be visible with current filter
   * @param {Document} document
   * @returns {boolean}
   */
  static isDocumentVisible(document) {
    const filterMode = game.settings.get(MODULE_ID, 'campaignFilterMode')

    if (filterMode === 'all') return true

    const activeCampaignId = game.settings.get(MODULE_ID, 'activeCampaignId')
    if (!activeCampaignId) return true

    const campaigns = CampaignFlags.getCampaigns(document)
    return campaigns.length === 0 || CampaignFlags.belongsToCampaign(document, activeCampaignId)
  }
}
