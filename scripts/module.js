/**
 * Crit-Fumble Core Module — Phase 1
 * Foundry VTT plugin for Crit-Fumble Gaming platform integration.
 *
 * Phase 1 features:
 *   - Campaign linking + GM panel
 *   - Party roster + session tracker
 *   - Quest sync → journal entries
 *   - Character sheet sync (bidirectional)
 *   - Voice: Discord, driven by campaign settings on Core
 *   - Chat log unification (Foundry ↔ Core)
 *   - VTT bridge for core-hosted iframe embedding
 */

import { CoreAPIClient } from './clients/api-client.js'
import { CampaignManager } from './views/campaign-manager.js'
import { QuestSyncManager } from './services/quest-sync.js'
import { SyncService } from './services/sync-service.js'
import { ChatSyncManager } from './services/chat-sync.js'
import { mountCFGSidebar } from './views/sidebar.js'
import { FilePickerCompat } from './utils/file-picker-compat.js'
import { registerCfgLinkMenu } from './views/cfg-link-settings.js'
import { applyHostedContext, getHostKind } from './auth/host-context.js'
import { mountConnectionBanner } from './views/connection-banner.js'
import { maybeShowFirstRunPrompt } from './views/first-run-prompt.js'
import { syncInstalledModules } from './sync/modules-sync.js'

/* -------------------------------------------- */
/*  Module-level State                           */
/* -------------------------------------------- */

const MODULE_ID = 'crit-fumble-core'
const MODULE_VERSION = '2.0.0'

/** @type {'full'|'narrative'} */
let _featureMode = 'narrative'

/** @type {string|null} e.g. '5e-compatible' */
let _platformSystemSlug = null

/** @type {string|null} */
let _campaignId = null

/** @type {'discord'} Voice is always Discord in phase 1. */
let _voiceProvider = 'discord'

/** @type {CoreAPIClient|null} */
let _api = null

/** @type {SyncService|null} */
let _syncService = null

/** @type {QuestSyncManager|null} */
let _questSync = null

/** @type {ChatSyncManager|null} */
let _chatSync = null

/* -------------------------------------------- */
/*  Global Exposure                              */
/* -------------------------------------------- */

window.CFGCore = {
  version: MODULE_VERSION,
  /** Open the GM campaign manager panel. */
  openCampaignManager: () => new CampaignManager().render(true),
  /** @returns {'full'|'narrative'} */
  featureMode: () => _featureMode,
  /** @returns {string|null} */
  platformSystemSlug: () => _platformSystemSlug,
  /** @returns {string|null} */
  campaignId: () => _campaignId,
  /**
   * Returns the active voice provider. Always 'discord' in phase 1.
   * @returns {'discord'}
   */
  voiceProvider: () => 'discord',
  /**
   * 'cfg-hosted' when Foundry is served from CFG infrastructure (#699 detect),
   * 'self-hosted' otherwise.
   * @returns {'cfg-hosted'|'self-hosted'}
   */
  hostKind: () => getHostKind(),
  /** @type {CoreAPIClient|null} Set after init. */
  api: null,
}

/* -------------------------------------------- */
/*  Init Hook — Register Settings & Keybindings */
/* -------------------------------------------- */

Hooks.once('init', () => {
  console.log(`CFG Core | Initializing v${MODULE_VERSION}`)

  // ---- Settings ----

  game.settings.register(MODULE_ID, 'coreApiUrl', {
    name: 'CFG Endpoint',
    hint: 'Crit-Fumble platform endpoint. Self-hosters change this; everyone else leaves the default.',
    scope: 'world',
    config: true,
    type: String,
    default: window.CORE_API_URL || 'https://core.crit-fumble.com',
  })

  game.settings.register(MODULE_ID, 'campaignId', {
    name: 'Campaign ID',
    hint: 'The Crit-Fumble campaign ID this Foundry world is linked to.',
    scope: 'world',
    config: true,
    type: String,
    default: window.CORE_CAMPAIGN_ID || '',
  })

  // Set automatically by the pair flow (#698). Hidden from the settings UI
  // so users can't paste in arbitrary strings; clear it via Unlink instead.
  // World-scope keeps the key with the same protection as other GM secrets
  // stored in Foundry's settings.db (Foundry has no built-in encryption for
  // module settings — see the #698 issue body).
  game.settings.register(MODULE_ID, 'apiKey', {
    scope: 'world',
    config: false,
    type: String,
    default: '',
  })

  // Optional installation ID returned by the pair flow once the server-side
  // schema work in #700 lands. Not user-visible.
  game.settings.register(MODULE_ID, 'installationId', {
    scope: 'world',
    config: false,
    type: String,
    default: '',
  })

  // First-run pair prompt suppression flag (#571). When the GM clicks
  // "Don't Show Again" on the in-plugin prompt, this flag stops it firing on
  // future world loads. Hidden from the settings UI — the dialog itself is
  // the only way to set it; clearing happens automatically on a successful
  // Link Now click so a future Unlink + reload re-surfaces the prompt.
  game.settings.register(MODULE_ID, 'firstRunPromptDismissed', {
    scope: 'world',
    config: false,
    type: Boolean,
    default: false,
  })

  // Host-environment detection (#699) — when Foundry is served by the CFG
  // VTT proxy, the proxy injects `window.__CFG_HOSTED_CONTEXT__` with the
  // endpoint, a pre-minted apiKey, an installationId and the cfgUserId. In
  // that case we auto-apply the injected context so the rest of `ready` sees
  // the same world settings the pair flow would have populated. Self-hosted /
  // third-party Foundry sees the original pair-button flow inside the menu.
  if (getHostKind() === 'cfg-hosted') {
    // Fire-and-forget: applyHostedContext does its own error logging, and
    // failing to write a setting here doesn't block the rest of init.
    void applyHostedContext()
  }
  // Always register the link-menu surface — it renders Link/Unlink for
  // self-hosted, and a read-only "Linked via CFG-hosted Foundry container"
  // row for cfg-hosted (the buttons are hidden, see cfg-link-settings.js).
  registerCfgLinkMenu()

  game.settings.register(MODULE_ID, 'autoSyncQuests', {
    name: 'Auto-sync Quests',
    hint: 'Automatically sync the campaign quest log to Foundry journal entries.',
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  })

  game.settings.register(MODULE_ID, 'chatSyncEnabled', {
    name: 'Chat Sync',
    hint: 'Mirror Foundry chat messages to the Core platform and receive messages sent from Core.',
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  })

  game.settings.register(MODULE_ID, 'voiceEnabled', {
    name: 'Voice Integration',
    hint: 'Enable voice chat integration for sessions (Discord).',
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  })

  /**
   * Per-campaign officer position configuration (preset + requireLeader flag).
   * Keyed by campaign ID. Managed via the Campaign Manager UI.
   */
  game.settings.register(MODULE_ID, 'campaignPositions', {
    scope: 'world',
    config: false,
    type: Object,
    default: {},
  })

  game.settings.register(MODULE_ID, 'playerApiKey', {
    name: 'Player API Key (Self-Hosted)',
    hint: 'Self-hosted only. Your personal CFG API key (cfk_...). Leave blank when Foundry runs inside the Core platform — your session is detected automatically. Generate a key at core.crit-fumble.com → Account → API Keys.',
    scope: 'client',
    config: true,
    type: String,
    default: '',
  })

  // ---- Keybindings ----

  game.keybindings.register(MODULE_ID, 'toggleVoice', {
    name: 'Toggle Voice (Mute/Unmute)',
    hint: 'Mute or unmute your voice connection.',
    editable: [{ key: 'KeyM', modifiers: ['Control'] }],
    onDown: () => {
      window.CFGVoice?.toggleMute?.()
    },
  })

  // ---- GM Scene Controls ----

  Hooks.on('getSceneControlButtons', (controls) => {
    if (!game.user.isGM) return
    const bar = controls.find((c) => c.name === 'token')
    if (!bar) return
    bar.tools.push({
      name: 'cfg-campaign-manager',
      title: 'CFG Campaign Manager',
      icon: 'fas fa-users',
      onClick: () => window.CFGCore.openCampaignManager(),
      button: true,
    })
  })

  console.log(`CFG Core | Settings and keybindings registered`)
})

/* -------------------------------------------- */
/*  Ready Hook — Main Initialization            */
/* -------------------------------------------- */

Hooks.once('ready', async () => {
  console.log(`CFG Core | Ready`)

  // Steer FilePicker away from User Data root, where Foundry blocks uploads
  // (modules/ and systems/ are overwritten on updates). Point it at the
  // current world's assets/ folder — pre-created server-side on provision.
  try {
    const FP = FilePickerCompat.getClass()
    if (FP && game.world?.id) {
      FP.LAST_BROWSED_DIRECTORY = `worlds/${game.world.id}/assets`
    }
  } catch (err) {
    console.warn('CFG Core | FilePicker default path setup failed (non-fatal):', err)
  }

  const apiUrl = game.settings.get(MODULE_ID, 'coreApiUrl')
  const apiKey = game.settings.get(MODULE_ID, 'apiKey') || null
  _campaignId = game.settings.get(MODULE_ID, 'campaignId') || window.CORE_CAMPAIGN_ID || null

  if (!_campaignId) {
    console.warn(`CFG Core | No campaign ID configured — set it in Module Settings.`)
    ui.notifications.warn('CFG Core: No campaign ID set. Configure it in Module Settings.')
    return
  }

  // Core-hosted: apiKey null → session cookie auth.  Self-hosted: apiKey set → Bearer token.
  _api = new CoreAPIClient(apiUrl, apiKey)
  window.CFGCore.api = _api
  console.log(`CFG Core | Auth mode: ${apiKey ? 'self-hosted (API key)' : 'core-hosted (session cookie)'}`)

  // Report system to Core and read back featureMode + voice provider from campaign settings.
  // Link this Foundry user to their platform account in parallel.
  const playerApiKey = game.settings.get(MODULE_ID, 'playerApiKey') || null
  await Promise.allSettled([
    _reportSystem(),
    game.user.isGM ? _checkRecommendedModules() : Promise.resolve(),
    // #339 — POST `game.modules` to CFG so the platform UI can list what's
    // installed in this Foundry world. GM-only; non-fatal on failure.
    game.user.isGM ? syncInstalledModules() : Promise.resolve(),
    _linkPlatformUser(apiUrl, playerApiKey, apiKey),
  ])

  _showFeatureModeBanner()

  // Quest sync
  if (game.settings.get(MODULE_ID, 'autoSyncQuests')) {
    _questSync = new QuestSyncManager(_api, null)
    _syncService = new SyncService(_api, _campaignId)
    try {
      await _questSync.initialize()
    } catch (err) {
      console.error('CFG Core | Quest sync init failed:', err)
    }
    _syncService.startAutoSync(5)
  }

  // Chat sync — mirrors Foundry chat ↔ Core platform
  if (game.settings.get(MODULE_ID, 'chatSyncEnabled')) {
    _chatSync = new ChatSyncManager(_api, _campaignId)
    _chatSync.start()
  }

  // CFG sidebar — Shell-based dock surfaced in the Foundry viewport. Uses the
  // player's key on self-hosted Foundry so the iframe inherits their identity;
  // core-hosted Foundry relies on the same-origin session cookie instead.
  mountCFGSidebar({
    coreUrl: apiUrl,
    token: playerApiKey || null,
  })

  // Offline banner (#699). Subscribes to `pluginConnectionState` and surfaces
  // a small fixed-position pill whenever fetchCfg's last call hit the network
  // error branch. Local Foundry features keep working — the banner is purely
  // informational.
  mountConnectionBanner()

  // First-run pair prompt (#571). Self-hosted / third-party Foundry GMs see
  // a one-tap "Link this world to CFG" dialog when the world has never been
  // paired. Players, CFG-hosted worlds, already-linked worlds, and worlds
  // where the GM clicked "Don't Show Again" are all skipped inside
  // maybeShowFirstRunPrompt. The 1.5s defer lets Foundry's main UI land
  // before our dialog steals focus.
  setTimeout(() => maybeShowFirstRunPrompt(), 1500)

  console.log(
    `CFG Core | Ready — featureMode: ${_featureMode}, platform: ${_platformSystemSlug ?? 'unknown'}, ` +
      `campaign: ${_campaignId}, voice: discord`,
  )
})

/* -------------------------------------------- */
/*  System Reporter                              */
/* -------------------------------------------- */

/**
 * Report this Foundry world's game system to Core and read back:
 *   - featureMode ('full'|'narrative')
 *   - platformSystemSlug
 *   - voiceProvider ('discord') — always Discord in phase 1
 *
 * Only the GM sends the PATCH; all users benefit from the state it sets.
 */
async function _reportSystem() {
  if (!_campaignId || !_api) return

  try {
    if (game.user.isGM) {
      const result = await _api.patch(`/api/campaigns/${_campaignId}/foundry`, {
        foundrySystemId: game.system.id,
      })

      if (result?.featureMode) _featureMode = result.featureMode
      if (result?.platformSystemSlug) _platformSystemSlug = result.platformSystemSlug
    }

    console.log(
      _featureMode === 'full'
        ? `CFG Core | featureMode: full | platform: ${_platformSystemSlug}`
        : `CFG Core | featureMode: narrative`,
    )
  } catch (err) {
    console.warn('CFG Core | System reporter failed (non-fatal):', err.message)
  }
}

/* -------------------------------------------- */
/*  Platform Account Linking                     */
/* -------------------------------------------- */

/**
 * Link this Foundry user to their Core platform account.
 *
 * Core-hosted: session cookie auto-identifies the user — no key needed.
 * Self-hosted: each player sets their personal cfk_ key in Module Settings → Player API Key.
 *   If a player hasn't set one, we show a notification prompting them to do so.
 *
 * On success: stores platformUserId in a user flag and broadcasts the
 *   platformUserId↔foundryUserId mapping.
 *
 * @param {string} apiUrl
 * @param {string|null} playerApiKey  — client-scoped player key (null → session cookie)
 * @param {string|null} worldApiKey   — world-scoped GM key (non-null on self-hosted)
 */
async function _linkPlatformUser(apiUrl, playerApiKey, worldApiKey) {
  // For self-hosted instances, if no player key is set, we can't identify the player individually.
  const isSelfHosted = Boolean(worldApiKey)
  if (isSelfHosted && !playerApiKey) {
    ui.notifications.warn(
      'CFG Core: Link your personal account for voice and character sync. ' +
        'Add your API key in Module Settings → Player API Key.',
      { permanent: false },
    )
    return
  }

  const api = new CoreAPIClient(apiUrl, playerApiKey)
  try {
    const data = await api.get('/api/v1/account/user')
    const platformUserId = data?.user?.id
    if (!platformUserId) return

    await game.user.setFlag(MODULE_ID, 'platformUserId', platformUserId)
    console.log(`CFG Core | Account linked: platform ${platformUserId} ↔ Foundry ${game.user.id}`)

    // Broadcast identity so other clients can build their identity maps
    game.socket.emit('module.crit-fumble-core', {
      type: 'av-identity',
      platformUserId,
      foundryUserId: game.user.id,
    })
  } catch (err) {
    console.warn('CFG Core | Platform account link failed (non-fatal):', err.message)
  }
}

/* -------------------------------------------- */
/*  Module Setup Check                           */
/* -------------------------------------------- */

async function _checkRecommendedModules() {
  if (!_campaignId || !_api) return

  try {
    const config = await _api.getFoundryConfig(_campaignId)
    const defaultModules = config?.defaultModules ?? []
    if (!defaultModules.length) return

    const missing = defaultModules
      .filter((mod) => mod.autoInstall === false)
      .filter((mod) => !game.modules.get(mod.id)?.active)
      .map((mod) => mod.id)

    if (!missing.length) return

    const systemName = config?.systemName ?? game.system.title ?? game.system.id
    ui.notifications.warn(
      `CFG recommends these modules for ${systemName}: ${missing.join(', ')}. Install them in the Module Manager.`,
    )
    console.log(`CFG Core | Recommended modules not active:`, missing)
  } catch (err) {
    console.log('CFG Core | Module config check skipped:', err.message)
  }
}

/* -------------------------------------------- */
/*  Feature Mode Banner                          */
/* -------------------------------------------- */

function _showFeatureModeBanner() {
  if (_featureMode === 'full') {
    ui.notifications.info(`CFG Core: Full integration active — ${_platformSystemSlug} tools enabled`, {
      permanent: false,
    })
  } else {
    ui.notifications.info('CFG Core: Narrative tools active — voice, quests, party roster, chat', { permanent: false })
  }
}
