/**
 * VTT Bridge - PostMessage Communication Layer
 * Enables secure communication between embedded iframes and Foundry VTT
 *
 * The bridge exposes controlled access to Foundry APIs:
 * - Actors (read player's owned actors, limited GM access)
 * - Journals (read/write with permission checks)
 * - Settings (module settings only)
 * - Users (current user info)
 * - Rolls (trigger dice rolls)
 */

const MODULE_ID = 'crit-fumble-core'

/**
 * Allowed origins for postMessage communication
 * In production, this should be restricted to your core domain
 */
const ALLOWED_ORIGINS = [
  'https://core.crit-fumble.com',
  'http://localhost:3000', // Local dev
  'http://127.0.0.1:3000',
]

/**
 * Message types for VTT Bridge protocol
 */
export const VTT_BRIDGE_MESSAGES = {
  // Handshake
  READY: 'vtt:ready',
  INIT: 'vtt:init',

  // Requests (iframe -> VTT)
  REQUEST: 'vtt:request',

  // Responses (VTT -> iframe)
  RESPONSE: 'vtt:response',
  ERROR: 'vtt:error',

  // Events (VTT -> iframe, push notifications)
  EVENT: 'vtt:event',
}

/**
 * Available API methods that iframes can call
 */
const API_METHODS = {
  // User & Session
  'user.getCurrent': getCurrentUser,
  'user.isGM': () => game.user.isGM,

  // Actors
  'actors.getOwned': getOwnedActors,
  'actors.get': getActor,
  'actors.update': updateActor,

  // Journals
  'journals.get': getJournalEntry,
  'journals.getPage': getJournalPage,
  'journals.create': createJournalEntry,
  'journals.update': updateJournalEntry,

  // Settings
  'settings.get': getModuleSetting,
  'settings.set': setModuleSetting,

  // Rolls
  'roll.dice': rollDice,
  'roll.check': rollAbilityCheck,

  // World Info
  'world.getInfo': getWorldInfo,
  'world.getActorFolders': getActorFolders,

  // Campaign (via Core API)
  'campaign.getCurrent': getCurrentCampaign,

  // UI
  'ui.notify': showNotification,
  'ui.dialog': showDialog,
}

/**
 * VTT Bridge class - manages postMessage communication
 */
export class VTTBridge {
  constructor() {
    this._listeners = new Map()
    this._pendingRequests = new Map()
    this._requestId = 0
    this._registeredFrames = new Set()
    this._boundMessageHandler = this._handleMessage.bind(this)
  }

  /**
   * Initialize the bridge and start listening for messages
   */
  initialize() {
    window.addEventListener('message', this._boundMessageHandler)
    console.log(`[VTTBridge] Initialized, listening for messages from: ${ALLOWED_ORIGINS.join(', ')}`)
  }

  /**
   * Cleanup when module is disabled
   */
  destroy() {
    window.removeEventListener('message', this._boundMessageHandler)
    this._registeredFrames.clear()
    this._pendingRequests.clear()
    console.log('[VTTBridge] Destroyed')
  }

  /**
   * Register an iframe for communication
   * @param {HTMLIFrameElement} iframe - The iframe element
   * @param {string} origin - Expected origin
   */
  registerFrame(iframe, origin) {
    if (!ALLOWED_ORIGINS.includes(origin)) {
      console.warn(`[VTTBridge] Refusing to register frame with untrusted origin: ${origin}`)
      return false
    }

    this._registeredFrames.add(iframe)

    // Send ready message when iframe loads
    iframe.addEventListener('load', () => {
      this._sendToFrame(
        iframe,
        {
          type: VTT_BRIDGE_MESSAGES.READY,
          payload: {
            moduleId: MODULE_ID,
            user: getCurrentUser(),
            world: getWorldInfo(),
          },
        },
        origin,
      )
    })

    return true
  }

  /**
   * Unregister an iframe
   * @param {HTMLIFrameElement} iframe - The iframe element
   */
  unregisterFrame(iframe) {
    this._registeredFrames.delete(iframe)
  }

  /**
   * Send an event to all registered iframes
   * @param {string} eventName - Event name
   * @param {*} data - Event data
   */
  broadcastEvent(eventName, data) {
    const message = {
      type: VTT_BRIDGE_MESSAGES.EVENT,
      event: eventName,
      payload: data,
    }

    for (const iframe of this._registeredFrames) {
      if (iframe.contentWindow) {
        // Try each allowed origin
        for (const origin of ALLOWED_ORIGINS) {
          try {
            iframe.contentWindow.postMessage(message, origin)
          } catch (e) {
            // Origin mismatch, try next
          }
        }
      }
    }
  }

  /**
   * Handle incoming postMessage
   * @private
   */
  async _handleMessage(event) {
    // Validate origin
    if (!ALLOWED_ORIGINS.includes(event.origin)) {
      return
    }

    const { type, method, params, requestId } = event.data || {}

    if (type !== VTT_BRIDGE_MESSAGES.REQUEST) {
      return
    }

    console.log(`[VTTBridge] Received request: ${method}`, params)

    try {
      // Check if method exists
      const handler = API_METHODS[method]
      if (!handler) {
        throw new Error(`Unknown method: ${method}`)
      }

      // Execute the method
      const result = await handler(params)

      // Send response
      event.source.postMessage(
        {
          type: VTT_BRIDGE_MESSAGES.RESPONSE,
          requestId,
          result,
        },
        event.origin,
      )
    } catch (error) {
      console.error(`[VTTBridge] Error handling ${method}:`, error)

      event.source.postMessage(
        {
          type: VTT_BRIDGE_MESSAGES.ERROR,
          requestId,
          error: error.message,
        },
        event.origin,
      )
    }
  }

  /**
   * Send message to a specific iframe
   * @private
   */
  _sendToFrame(iframe, message, origin) {
    if (iframe.contentWindow) {
      iframe.contentWindow.postMessage(message, origin)
    }
  }
}

/* -------------------------------------------- */
/*  API Method Implementations                   */
/* -------------------------------------------- */

function getCurrentUser() {
  const user = game.user
  return {
    id: user.id,
    name: user.name,
    avatar: user.avatar,
    isGM: user.isGM,
    color: user.color,
    character: user.character
      ? {
          id: user.character.id,
          name: user.character.name,
          img: user.character.img,
        }
      : null,
  }
}

function getWorldInfo() {
  return {
    id: game.world.id,
    title: game.world.title,
    system: game.system.id,
    systemTitle: game.system.title,
    coreVersion: game.version,
  }
}

function getOwnedActors() {
  const actors = game.actors.filter((a) => a.isOwner)
  return actors.map((a) => ({
    id: a.id,
    name: a.name,
    img: a.img,
    type: a.type,
    system: a.system,
  }))
}

function getActor(params) {
  const actor = game.actors.get(params.id)
  if (!actor) throw new Error('Actor not found')
  if (!actor.isOwner && !game.user.isGM) throw new Error('No permission')

  return {
    id: actor.id,
    name: actor.name,
    img: actor.img,
    type: actor.type,
    system: actor.system,
    items: actor.items.map((i) => ({
      id: i.id,
      name: i.name,
      type: i.type,
      img: i.img,
    })),
  }
}

async function updateActor(params) {
  const actor = game.actors.get(params.id)
  if (!actor) throw new Error('Actor not found')
  if (!actor.isOwner && !game.user.isGM) throw new Error('No permission')

  await actor.update(params.data)
  return { success: true, id: actor.id }
}

function getJournalEntry(params) {
  const entry = game.journal.get(params.id)
  if (!entry) throw new Error('Journal entry not found')

  // Check view permission
  const permission = entry.getUserLevel(game.user)
  if (permission < CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER) {
    throw new Error('No permission')
  }

  return {
    id: entry.id,
    name: entry.name,
    pages: entry.pages.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      sort: p.sort,
    })),
  }
}

function getJournalPage(params) {
  const entry = game.journal.get(params.entryId)
  if (!entry) throw new Error('Journal entry not found')

  const page = entry.pages.get(params.pageId)
  if (!page) throw new Error('Journal page not found')

  return {
    id: page.id,
    name: page.name,
    type: page.type,
    text: page.text,
    image: page.src,
    video: page.video,
  }
}

async function createJournalEntry(params) {
  if (!game.user.isGM && !params.folder) {
    throw new Error('Only GMs can create root-level journal entries')
  }

  const entry = await JournalEntry.create({
    name: params.name,
    folder: params.folder,
    pages: params.pages || [],
  })

  return { id: entry.id, name: entry.name }
}

async function updateJournalEntry(params) {
  const entry = game.journal.get(params.id)
  if (!entry) throw new Error('Journal entry not found')

  const permission = entry.getUserLevel(game.user)
  if (permission < CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER && !game.user.isGM) {
    throw new Error('No permission to edit')
  }

  await entry.update(params.data)
  return { success: true, id: entry.id }
}

function getModuleSetting(params) {
  const moduleId = params.moduleId || MODULE_ID
  // Only allow reading crit-fumble module settings
  if (!moduleId.startsWith('crit-fumble') && !moduleId.startsWith('rotfs')) {
    throw new Error('Can only read CFG module settings')
  }

  return game.settings.get(moduleId, params.key)
}

async function setModuleSetting(params) {
  const moduleId = params.moduleId || MODULE_ID
  if (!moduleId.startsWith('crit-fumble') && !moduleId.startsWith('rotfs')) {
    throw new Error('Can only write CFG module settings')
  }

  await game.settings.set(moduleId, params.key, params.value)
  return { success: true }
}

async function rollDice(params) {
  const roll = await new Roll(params.formula).evaluate()

  if (params.showChat !== false) {
    await roll.toMessage({
      speaker: ChatMessage.getSpeaker(),
      flavor: params.flavor,
    })
  }

  return {
    formula: roll.formula,
    total: roll.total,
    dice: roll.dice.map((d) => ({
      faces: d.faces,
      results: d.results.map((r) => r.result),
    })),
  }
}

async function rollAbilityCheck(params) {
  const actor = game.actors.get(params.actorId)
  if (!actor) throw new Error('Actor not found')

  // This is system-specific, handle dnd5e
  if (game.system.id === 'dnd5e') {
    const roll = await actor.rollAbilityTest(params.ability, {
      chatMessage: params.showChat !== false,
    })
    return {
      total: roll.total,
      formula: roll.formula,
    }
  }

  throw new Error(`Ability checks not implemented for system: ${game.system.id}`)
}

function getActorFolders() {
  return game.folders
    .filter((f) => f.type === 'Actor')
    .map((f) => ({
      id: f.id,
      name: f.name,
      color: f.color,
      parent: f.folder?.id || null,
    }))
}

function getCurrentCampaign() {
  try {
    const campaignId = game.settings.get(MODULE_ID, 'linkedCampaignId')
    const worldId = game.settings.get(MODULE_ID, 'linkedWorldId')

    return {
      campaignId,
      worldId,
      isLinked: !!(campaignId && worldId),
    }
  } catch {
    return { campaignId: null, worldId: null, isLinked: false }
  }
}

function showNotification(params) {
  ui.notifications[params.type || 'info'](params.message)
  return { success: true }
}

async function showDialog(params) {
  return new Promise((resolve) => {
    new Dialog({
      title: params.title,
      content: params.content,
      buttons: {
        yes: {
          icon: '<i class="fas fa-check"></i>',
          label: params.yesLabel || 'Yes',
          callback: () => resolve({ confirmed: true }),
        },
        no: {
          icon: '<i class="fas fa-times"></i>',
          label: params.noLabel || 'No',
          callback: () => resolve({ confirmed: false }),
        },
      },
      default: 'yes',
    }).render(true)
  })
}

/* -------------------------------------------- */
/*  Singleton Instance                           */
/* -------------------------------------------- */

export const vttBridge = new VTTBridge()
