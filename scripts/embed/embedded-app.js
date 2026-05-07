/**
 * Embedded App - Foundry ApplicationV2 wrapper for iframe-based apps
 * Renders apps from core.crit-fumble.com inside Foundry VTT
 */

import { vttBridge } from './vtt-bridge.js'

const MODULE_ID = 'crit-fumble-core'

/**
 * Get the base URL for embedded apps
 * @returns {string} Base URL
 */
function getEmbedBaseUrl() {
  // Check for override in settings (useful for local dev)
  try {
    const override = game.settings.get(MODULE_ID, 'embedBaseUrl')
    if (override) return override
  } catch {
    // Setting not registered yet
  }

  // Default to core API URL
  try {
    const coreUrl = game.settings.get(MODULE_ID, 'coreApiUrl')
    if (coreUrl) return coreUrl
  } catch {
    // Setting not registered
  }

  return 'https://core.crit-fumble.com'
}

/**
 * EmbeddedApp - A Foundry ApplicationV2 that renders an iframe
 */
export class EmbeddedApp extends foundry.applications.api.ApplicationV2 {
  /**
   * @param {object} options - Application options
   * @param {string} options.route - The embed route (e.g., '/embed/onboarding')
   * @param {object} options.params - Query parameters to pass to the iframe
   * @param {string} options.title - Window title
   * @param {number} options.width - Window width
   * @param {number} options.height - Window height
   */
  constructor(options = {}) {
    super(options)

    this.route = options.route || '/embed'
    this.params = options.params || {}
    this.iframe = null
    this._eventHandlers = new Map()
  }

  static DEFAULT_OPTIONS = {
    id: 'cfg-embedded-app',
    tag: 'div',
    window: {
      title: 'CFG App',
      icon: 'fa-solid fa-window-maximize',
      resizable: true,
      positioned: true,
    },
    position: {
      width: 800,
      height: 600,
    },
    classes: ['themed', 'cfg-app', 'cfg-embedded-app'],
  }

  /**
   * Build the iframe URL with auth token and params
   * @returns {string} Full iframe URL
   */
  _buildIframeUrl() {
    const baseUrl = getEmbedBaseUrl()
    const url = new URL(this.route, baseUrl)

    // Add query params
    for (const [key, value] of Object.entries(this.params)) {
      url.searchParams.set(key, String(value))
    }

    // Add user context
    url.searchParams.set('userId', game.user.id)
    url.searchParams.set('worldId', game.world.id)
    url.searchParams.set('isGM', game.user.isGM ? '1' : '0')

    // Add auth token if available
    try {
      const token = game.settings.get(MODULE_ID, 'coreApiToken')
      if (token) {
        url.searchParams.set('token', token)
      }
    } catch {
      // No token configured
    }

    return url.toString()
  }

  /**
   * Get the origin for postMessage validation
   * @returns {string} Origin
   */
  _getOrigin() {
    const baseUrl = getEmbedBaseUrl()
    const url = new URL(baseUrl)
    return url.origin
  }

  /**
   * Render the application content
   * @param {HTMLElement} element - The element to render into
   * @param {object} options - Render options
   */
  async _renderHTML(context, options) {
    const container = document.createElement('div')
    container.className = 'cfg-embedded-container'
    container.style.cssText = 'width: 100%; height: 100%; display: flex; flex-direction: column;'

    // Loading state
    const loading = document.createElement('div')
    loading.className = 'cfg-embedded-loading'

    const loadingContent = document.createElement('div')
    loadingContent.style.cssText =
      'display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: var(--color-text-dark-secondary);'

    const spinner = document.createElement('i')
    spinner.className = 'fas fa-spinner fa-spin fa-2x'
    spinner.style.marginBottom = '1rem'
    loadingContent.appendChild(spinner)

    const loadingText = document.createElement('span')
    loadingText.textContent = 'Loading application...'
    loadingContent.appendChild(loadingText)

    loading.appendChild(loadingContent)
    container.appendChild(loading)

    // Create iframe
    this.iframe = document.createElement('iframe')
    this.iframe.src = this._buildIframeUrl()
    this.iframe.style.cssText = 'width: 100%; height: 100%; border: none; flex: 1; display: none;'
    this.iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups')
    this.iframe.setAttribute('allow', 'clipboard-write')

    // Register with bridge
    const origin = this._getOrigin()
    vttBridge.registerFrame(this.iframe, origin)

    // Show iframe when loaded
    this.iframe.addEventListener('load', () => {
      loading.style.display = 'none'
      this.iframe.style.display = 'block'
    })

    // Handle errors
    this.iframe.addEventListener('error', () => {
      loading.textContent = '' // Clear loading

      const errorContent = document.createElement('div')
      errorContent.style.cssText =
        'display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: var(--color-text-dark-secondary);'

      const errorIcon = document.createElement('i')
      errorIcon.className = 'fas fa-exclamation-triangle fa-2x'
      errorIcon.style.cssText = 'margin-bottom: 1rem; color: var(--color-level-error);'
      errorContent.appendChild(errorIcon)

      const errorText = document.createElement('span')
      errorText.textContent = 'Failed to load application'
      errorContent.appendChild(errorText)

      const retryBtn = document.createElement('button')
      retryBtn.type = 'button'
      retryBtn.className = 'cfg-retry-btn'
      retryBtn.style.marginTop = '1rem'
      retryBtn.textContent = 'Retry'
      retryBtn.addEventListener('click', () => {
        this.iframe.src = this._buildIframeUrl()

        loading.textContent = '' // Clear error

        const retryContent = document.createElement('div')
        retryContent.style.cssText =
          'display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: var(--color-text-dark-secondary);'

        const retrySpinner = document.createElement('i')
        retrySpinner.className = 'fas fa-spinner fa-spin fa-2x'
        retrySpinner.style.marginBottom = '1rem'
        retryContent.appendChild(retrySpinner)

        const retryText = document.createElement('span')
        retryText.textContent = 'Loading application...'
        retryContent.appendChild(retryText)

        loading.appendChild(retryContent)
      })
      errorContent.appendChild(retryBtn)

      loading.appendChild(errorContent)
    })

    container.appendChild(this.iframe)
    return container
  }

  /**
   * Handle element replacement
   */
  _replaceHTML(result, content, options) {
    content.replaceChildren(result)
  }

  /**
   * Register an event handler for messages from the iframe
   * @param {string} event - Event name
   * @param {function} handler - Handler function
   */
  on(event, handler) {
    if (!this._eventHandlers.has(event)) {
      this._eventHandlers.set(event, new Set())
    }
    this._eventHandlers.get(event).add(handler)
    return this
  }

  /**
   * Remove an event handler
   * @param {string} event - Event name
   * @param {function} handler - Handler function
   */
  off(event, handler) {
    if (this._eventHandlers.has(event)) {
      this._eventHandlers.get(event).delete(handler)
    }
    return this
  }

  /**
   * Send a message to the iframe
   * @param {string} type - Message type
   * @param {*} payload - Message payload
   */
  sendMessage(type, payload) {
    if (this.iframe?.contentWindow) {
      this.iframe.contentWindow.postMessage({ type, payload }, this._getOrigin())
    }
  }

  /**
   * Close the application
   */
  async close(options = {}) {
    // Unregister iframe from bridge
    if (this.iframe) {
      vttBridge.unregisterFrame(this.iframe)
    }

    return super.close(options)
  }
}

/* -------------------------------------------- */
/*  Pre-configured App Factories                 */
/* -------------------------------------------- */

/**
 * Open the onboarding wizard
 * @param {object} options - Options
 * @param {string} options.actorId - Actor to onboard (optional)
 * @param {string} options.step - Starting step (optional)
 */
export function openOnboardingWizard(options = {}) {
  const app = new EmbeddedApp({
    route: '/embed/onboarding',
    params: {
      actorId: options.actorId,
      step: options.step,
    },
    window: {
      title: 'Character Onboarding',
      icon: 'fa-solid fa-wand-magic-sparkles',
    },
    position: {
      width: 900,
      height: 700,
    },
  })

  app.render(true)
  return app
}

/**
 * Open the campaign dashboard
 */
export function openCampaignDashboard() {
  const app = new EmbeddedApp({
    route: '/embed/dashboard',
    params: {},
    window: {
      title: 'Campaign Dashboard',
      icon: 'fa-solid fa-chart-line',
    },
    position: {
      width: 1000,
      height: 700,
    },
  })

  app.render(true)
  return app
}

/**
 * Open a journal viewer
 * @param {string} entryId - Journal entry ID
 * @param {string} pageId - Page ID (optional)
 */
export function openJournalViewer(entryId, pageId = null) {
  const app = new EmbeddedApp({
    route: '/embed/journal',
    params: {
      entryId,
      pageId,
    },
    window: {
      title: 'Journal Viewer',
      icon: 'fa-solid fa-book-open',
    },
    position: {
      width: 800,
      height: 600,
    },
  })

  app.render(true)
  return app
}

/**
 * Open a character sheet viewer
 * @param {string} actorId - Actor ID
 */
export function openCharacterSheet(actorId) {
  const actor = game.actors.get(actorId)
  const app = new EmbeddedApp({
    route: '/embed/sheet',
    params: {
      actorId,
    },
    window: {
      title: actor ? `${actor.name} - Sheet` : 'Character Sheet',
      icon: 'fa-solid fa-id-card',
    },
    position: {
      width: 800,
      height: 700,
    },
  })

  app.render(true)
  return app
}

/**
 * Open the entity browser (Core admin embedded view)
 * @param {object} options
 * @param {string} [options.entityId] - Pre-select a specific entity
 * @param {string} [options.category] - Filter by category ('npc', 'creature', 'location', etc.)
 */
export function openEntityBrowser(options = {}) {
  const params = {}

  if (options.entityId) params.entityId = options.entityId
  if (options.category) params.category = options.category

  // Pass campaign context so Core can scope the view
  try {
    const campaignId = game.settings.get(MODULE_ID, 'linkedCampaignId')
    if (campaignId) params.campaignId = campaignId
  } catch {
    /* no campaign linked */
  }

  const app = new EmbeddedApp({
    route: '/admin/locations',
    params,
    window: {
      title: 'Entity Browser',
      icon: 'fa-solid fa-list',
    },
    position: {
      width: 1000,
      height: 700,
    },
  })

  app.render(true)
  return app
}

/**
 * Open the entity detail / edit sheet
 * @param {string|null} entityId - Entity ID (null = create new)
 * @param {string} [category] - Category for new entities ('npc', 'creature', 'location', etc.)
 */
export function openEntitySheet(entityId = null, category = 'npc') {
  const route = entityId ? `/admin/locations/${entityId}` : '/admin/locations'
  const params = {}

  if (category) params.category = category
  if (!entityId) params.new = '1'

  // Pass campaign context
  try {
    const campaignId = game.settings.get(MODULE_ID, 'linkedCampaignId')
    if (campaignId) params.campaignId = campaignId
  } catch {
    /* no campaign linked */
  }

  const app = new EmbeddedApp({
    route,
    params,
    window: {
      title: entityId ? 'Entity Details' : 'New Entity',
      icon: 'fa-solid fa-id-card',
    },
    position: {
      width: 800,
      height: 700,
    },
  })

  app.render(true)
  return app
}
