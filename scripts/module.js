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
import { CfgCampaignLinksDialog } from './views/cfg-campaign-links.js'
// import { mountCFGSidebar } from './views/sidebar.js' // disabled — see the mount call below
import { FilePickerCompat } from './utils/file-picker-compat.js'
import { registerCfgLinkMenu } from './views/cfg-link-settings.js'
import { applyHostedContext, getHostKind } from './auth/host-context.js'
import { mountConnectionBanner } from './views/connection-banner.js'
import { maybeShowFirstRunPrompt } from './views/first-run-prompt.js'
import { syncInstalledModules } from './sync/modules-sync.js'
import { ActivityHeartbeat } from './services/activity-heartbeat.js'
import { ProvisionDrain } from './services/provision-drain.js'
import { WorldActorSnapshot } from './services/world-actor-snapshot.js'
import { CharacterSyncManager } from './services/character-sync.js'
import { CharacterPullSync } from './services/character-pull-sync.js'
import { Overlay3D } from './services/overlay-3d.js'

/* -------------------------------------------- */
/*  Module-level State                           */
/* -------------------------------------------- */

const MODULE_ID = 'crit-fumble-core'
const MODULE_VERSION = '2.4.1'

/** @type {'full'|'narrative'} */
let _featureMode = 'narrative'

/** @type {string|null} e.g. '5e-compatible' */
let _platformSystemSlug = null

/**
 * CFG campaign ids that have linked THIS Foundry world via the N:M join
 * (`campaign_foundry_worlds`). Populated by `_resolveLinkedCampaigns` in
 * the ready hook. Per-campaign flows (`_resolveFeatureMode`,
 * `_checkRecommendedModules`) iterate this list; an empty list is
 * normal for unlinked worlds and just skips those flows.
 * @type {string[]}
 */
let _linkedCampaignIds = []

/** @type {CoreAPIClient|null} */
let _api = null

/** @type {ActivityHeartbeat|null} */
let _activityHeartbeat = null

/** @type {ProvisionDrain|null} */
let _provisionDrain = null

/** @type {WorldActorSnapshot|null} */
let _worldActorSnapshot = null

/** @type {CharacterPullSync|null} */
let _characterPullSync = null

/** @type {Overlay3D|null} 3D view-skin over the canvas (DRAFT). */
let _overlay3D = null

/* -------------------------------------------- */
/*  Global Exposure                              */
/* -------------------------------------------- */

window.CFGCore = {
  version: MODULE_VERSION,
  /** @returns {'full'|'narrative'} */
  featureMode: () => _featureMode,
  /** @returns {string|null} */
  platformSystemSlug: () => _platformSystemSlug,
  /** @returns {string|null} */
  /** @returns {string[]} Campaigns currently linked to this Foundry world via the N:M join. */
  linkedCampaignIds: () => [..._linkedCampaignIds],
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
/*  Helpers                                      */
/* -------------------------------------------- */

/**
 * Pick the right default for `coreApiUrl` based on how Foundry is being
 * served. When the page path begins with `/servers/foundryvtt/` we're
 * inside the CFG VTT proxy — core-browser is at the same origin (localdev
 * tunnel, staging, or prod). Self-hosted Foundry falls through to the
 * prod URL; the user can override via Module Settings.
 *
 * This sidesteps the (not-yet-implemented) `__CFG_HOSTED_CONTEXT__`
 * injection that host-context.js anticipates — once the proxy injects
 * the global, `applyHostedContext` overwrites this default with the
 * server-supplied endpoint anyway, so this stays correct as a fallback.
 */
function _detectDefaultCoreApiUrl() {
  if (typeof window === 'undefined') return 'https://core.crit-fumble.com'
  try {
    if (window.location.pathname.startsWith('/servers/foundryvtt/')) {
      return window.location.origin
    }
  } catch {
    // location access can throw in restricted contexts — non-fatal
  }
  return 'https://core.crit-fumble.com'
}

/**
 * Extract the installation id from the page URL when running cfg-hosted.
 * Post-route-rename, cfg-hosted Foundry is always served from
 * `/servers/foundryvtt/{installationId}/...`. Reading the path is the
 * cheapest + most reliable way to get the installation id — no
 * dependency on the proxy injecting `__CFG_HOSTED_CONTEXT__` (which is
 * stubbed for a future commit) or on the pair-flow having run.
 *
 * Returns null for self-hosted Foundry or when the URL doesn't match
 * the cfg-hosted route shape.
 */
function _detectInstallationIdFromUrl() {
  if (typeof window === 'undefined') return null
  try {
    const match = window.location.pathname.match(/^\/servers\/foundryvtt\/([^/]+)/)
    return match?.[1] || null
  } catch {
    return null
  }
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
    default: window.CORE_API_URL || _detectDefaultCoreApiUrl(),
  })

  // The legacy single-campaign `campaignId` setting has been retired. With
  // many-to-many linking (`campaign_foundry_worlds` join), a world can host
  // multiple campaigns and a campaign can be played across multiple worlds.
  // The Linked Campaigns dialog (game.settings.registerMenu below) is the
  // single source of truth; plugin-side flows that need a campaign id
  // iterate over the linked set returned by /api/v1/account/foundry/campaigns.

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

  /**
   * Per-campaign officer position configuration (preset + requireLeader flag).
   * Hidden from the settings UI — currently unused by any active surface,
   * kept registered as `Object` so existing saved values don't error.
   */
  game.settings.register(MODULE_ID, 'campaignPositions', {
    scope: 'world',
    config: false,
    type: Object,
    default: {},
  })

  // ── Module Settings → Linked Campaigns ────────────────────────────────────
  // GM-only multi-link manager. The `campaignId` setting (handled by the
  // dropdown below) binds the world to ONE campaign for plugin-side sync;
  // this dialog manages the N:M database link table — "which campaigns
  // can be played in this world" — backed by /api/v1/account/foundry/campaigns.
  game.settings.registerMenu(MODULE_ID, 'campaignLinks', {
    name: 'Linked Campaigns',
    label: 'Open Linked Campaigns',
    hint: 'Manage which CFG campaigns can be played in this Foundry world. Many campaigns can share one world.',
    icon: 'fas fa-link',
    type: CfgCampaignLinksDialog,
    restricted: true,
  })

  console.log(`CFG Core | Settings and keybindings registered`)
})

/* -------------------------------------------- */
/*  Ready Hook — Main Initialization            */
/* -------------------------------------------- */

Hooks.once('ready', async () => {
  console.log(`CFG Core | Ready`)

  // Auto-correct `coreApiUrl` + `installationId` when running cfg-hosted
  // (proxied at `/servers/foundryvtt/{installationId}/*`). Existing worlds
  // may have stale values saved before the smart default landed — typically
  // the prod URL, which breaks iframe embedding in localdev / staging /
  // private tunnels. The installationId derives from the page path so the
  // plugin doesn't depend on `__CFG_HOSTED_CONTEXT__` injection or the
  // pair-flow having run. Idempotent: only writes on actual change.
  try {
    if (typeof window !== 'undefined' && window.location.pathname.startsWith('/servers/foundryvtt/')) {
      const detectedUrl = window.location.origin
      const storedUrl = game.settings.get(MODULE_ID, 'coreApiUrl')
      if (storedUrl !== detectedUrl) {
        await game.settings.set(MODULE_ID, 'coreApiUrl', detectedUrl)
        console.log(`CFG Core | coreApiUrl auto-corrected to ${detectedUrl} (was ${storedUrl})`)
      }

      const detectedInstallId = _detectInstallationIdFromUrl()
      if (detectedInstallId) {
        const storedInstallId = game.settings.get(MODULE_ID, 'installationId')
        if (storedInstallId !== detectedInstallId) {
          await game.settings.set(MODULE_ID, 'installationId', detectedInstallId)
          console.log(`CFG Core | installationId auto-corrected to ${detectedInstallId} (was ${storedInstallId || 'unset'})`)
        }
      }
    }
  } catch (err) {
    console.warn('CFG Core | host-context auto-correct failed (non-fatal):', err?.message || err)
  }

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
  // cfg-hosted Foundry is served same-origin with core (/servers/foundryvtt/<slug>/…),
  // so the same-origin session cookie is the auth — never the pair-flow API key,
  // even if a stale one is stored from a prior self-hosted pair (the stale key
  // 401s on the dev stack and breaks plugin↔core calls — #43). Reserve the key
  // for genuinely self-hosted installs.
  const apiKey = getHostKind() === 'cfg-hosted' ? null : game.settings.get(MODULE_ID, 'apiKey') || null

  // Core-hosted: apiKey null → session cookie auth.  Self-hosted: apiKey set → Bearer token.
  _api = new CoreAPIClient(apiUrl, apiKey)
  window.CFGCore.api = _api
  console.log(`CFG Core | Auth mode: ${apiKey ? 'self-hosted (API key)' : 'core-hosted (session cookie)'}`)

  // Resolve the campaigns linked to this Foundry world (N:M join, source of
  // truth lives in the platform DB). `_linkedCampaignIds` drives the
  // per-campaign report + module-check flows; an empty list is fine —
  // those flows just skip.
  _linkedCampaignIds = await _resolveLinkedCampaigns()

  // Report system to each linked campaign and check recommended modules
  // for each. Link this Foundry user to their platform account in parallel.
  await Promise.allSettled([
    _resolveFeatureMode(),
    game.user.isGM ? _checkRecommendedModules() : Promise.resolve(),
    // #339 — POST `game.modules` to CFG so the platform UI can list what's
    // installed in this Foundry world. GM-only; non-fatal on failure.
    game.user.isGM ? syncInstalledModules() : Promise.resolve(),
    _linkPlatformUser(apiUrl, apiKey),
  ])

  _showFeatureModeBanner()

  // Active-user heartbeat (cfs#109) — reports game.users.active to Core so
  // server-side idle-shutdown automation has a real signal. Only runs when
  // this world is linked to an installation (cfg-hosted, or self-hosted
  // after pairing); the single-reporter election lives inside the class.
  const heartbeatInstallId = game.settings.get(MODULE_ID, 'installationId') || null
  if (heartbeatInstallId) {
    _activityHeartbeat = new ActivityHeartbeat(_api, heartbeatInstallId)
    _activityHeartbeat.start()
  }

  // Runtime player provisioning (cfs live-world SSO). When this client is a GM,
  // drain the platform's pending-provision queue — create the reserved Foundry
  // User docs (Foundry only lets a GM do this) so the proxy can SSO invited
  // players into a RUNNING world. Single-GM election lives in the class, so it's
  // safe that this starts in every GM browser AND the headless service-GM.
  if (heartbeatInstallId && game.user.isGM) {
    _provisionDrain = new ProvisionDrain(_api, heartbeatInstallId)
    _provisionDrain.start()
  }

  // Whole-world actor mirror (cfs#17) — snapshot every actor to the platform so
  // their sheets stay viewable on the web once this world goes offline. GM-only
  // (a GM sees all actors with full data); the single-reporter election lives in
  // the class. Runs for any linked world — installation key (cfg-hosted) OR a
  // paired key (self-hosted), which is what makes self-hosted sheets viewable.
  if ((heartbeatInstallId || apiKey) && game.user.isGM) {
    _worldActorSnapshot = new WorldActorSnapshot(_api)
    _worldActorSnapshot.start()
  }

  // Core→Foundry character write-back (cfs#17 #147) — pull the platform's
  // pending+core FoundryActorSync records for each linked campaign and apply the
  // edited sheet to the live actor, then push it back to mark the record synced.
  // GM-only (only a GM can write actors with full data); the single-reporter
  // election lives in the class. Gated identically to the world-actor mirror —
  // a linked installation (cfg-hosted) OR a paired key (self-hosted).
  if ((heartbeatInstallId || apiKey) && game.user.isGM) {
    _characterPullSync = new CharacterPullSync(_api, new CharacterSyncManager(_api), () => _linkedCampaignIds)
    _characterPullSync.start()
  }

  // 3D overlay (DRAFT — cfs 3D-VTT slice 1) — a three.js view-skin over the
  // canvas. Available to every user; three.js loads lazily on first toggle.
  // The toggle lives in the Token scene controls. Reads Foundry's own scene +
  // token + elevation data; no new server, sync rides Foundry's broadcasts.
  // See docs/notes/3d-vtt-scope.md (cfg-core-dev-tools).
  try {
    _overlay3D = new Overlay3D()
    _overlay3D.start()
  } catch (err) {
    console.warn('CFG Core | Overlay3D init failed (non-fatal):', err)
  }

  // CFG sidebar — DISABLED 2026-06-22. The collapsible "CFG" rail loaded an
  // iframe to /foundry/sidebar, which 404s, and the rail isn't the surface we
  // want anyway. Hidden pending a proper ApplicationV2 "Surface" window inside
  // Foundry (tracked separately). sidebar.js (mount/unmount + its unit test) is
  // kept intact; re-enable by uncommenting the import + this call.
  // mountCFGSidebar({
  //   coreUrl: apiUrl,
  //   token: apiKey || null,
  // })

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

  // Report the loaded world to CFG so the platform's Server Manager UI
  // can show "running — <World> loaded" instead of the stale FOUNDRY_WORLD
  // env it used to read. The platform routes installation resolution
  // through the player's API key; on core-hosted (no apiKey) the session
  // cookie covers it. Non-fatal — the platform falls back to "loading…"
  // and the 15-min safety net re-converges.
  _reportWorldLoaded(apiKey).catch((err) => {
    console.warn('CFG Core | world-load callback failed (non-fatal):', err)
  })

  console.log(
    `CFG Core | Ready — featureMode: ${_featureMode}, platform: ${_platformSystemSlug ?? 'unknown'}, ` +
      `linkedCampaigns: [${_linkedCampaignIds.join(', ')}]`,
  )
})

/* -------------------------------------------- */
/*  World-load Reporter                          */
/* -------------------------------------------- */

/**
 * POST the active world id to CFG so the platform's runtime state map
 * knows which world is loaded right now. Fired once per `ready` hook —
 * idempotent on the server side (repeated POSTs for the same world just
 * refresh `loadedAt`).
 *
 * Auth: the world-scoped `apiKey` (set by the pair flow on self-hosted,
 * by `applyHostedContext` on cfg-hosted) goes in as a Bearer token. When
 * absent we let the request through with whatever auth the iframe /
 * session cookie provides — the platform falls back to session-cookie
 * identity in that path.
 */
async function _reportWorldLoaded(apiKey) {
  if (!game.world?.id) return
  const apiUrl = game.settings.get(MODULE_ID, 'coreApiUrl')
  if (!apiUrl) return
  const url = `${apiUrl.replace(/\/+$/, '')}/api/v1/foundry/worlds/${encodeURIComponent(game.world.id)}/status`
  const headers = { 'content-type': 'application/json' }
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`
  const res = await fetch(url, {
    method: 'POST',
    headers,
    credentials: 'include',
    body: JSON.stringify({ status: 'ready' }),
  })
  if (!res.ok) {
    throw new Error(`world-load callback returned HTTP ${res.status}`)
  }
}

/* -------------------------------------------- */
/*  Linked Campaigns + System Reporter           */
/* -------------------------------------------- */

/**
 * Fetch the set of CFG campaigns linked to THIS Foundry world via the
 * many-to-many join (`campaign_foundry_worlds`). The GM manages the
 * link list in Module Settings → Linked Campaigns; this is the
 * canonical "which campaigns can play in this world" lookup.
 *
 * Returns an empty array when nothing is linked or the fetch fails —
 * downstream flows just skip rather than block plugin boot.
 */
async function _resolveLinkedCampaigns() {
  if (!_api) return []
  const installId = game.settings.get(MODULE_ID, 'installationId') || null
  const worldId = game.world?.id ?? null
  if (!installId || !worldId) return []
  try {
    const data = await _api.get('/api/v1/account/foundry/campaigns')
    const campaigns = Array.isArray(data?.data) ? data.data : []
    const linked = []
    for (const c of campaigns) {
      const matches = (c.linkedWorlds ?? []).some(
        (l) => l.installationId === installId && l.worldId === worldId,
      )
      if (matches) linked.push(c.id)
    }
    return linked
  } catch (err) {
    console.warn('CFG Core | linked-campaign resolution failed (non-fatal):', err?.message ?? err)
    return []
  }
}

/**
 * Adopt the FIRST linked campaign's `featureMode` + `platformSystemSlug` for
 * plugin-local state by READING its Foundry integration status. featureMode is
 * derived server-side from the campaign's configured game system — there is no
 * report-by-PATCH anymore (the old single-campaign `/api/campaigns/{id}/foundry`
 * PATCH was retired). Every user can read it, so no GM gate.
 *
 * No-op when no campaigns are linked (the world plays in 'narrative' mode).
 */
async function _resolveFeatureMode() {
  if (!_api || _linkedCampaignIds.length === 0) return

  try {
    for (const campaignId of _linkedCampaignIds) {
      try {
        const { foundry } = (await _api.getFoundryStatus(campaignId)) ?? {}
        if (foundry?.featureMode) {
          _featureMode = foundry.featureMode
          _platformSystemSlug = foundry.platformSystemSlug ?? null
          break // first linked campaign wins
        }
      } catch (err) {
        console.warn(`CFG Core | featureMode resolve failed for ${campaignId} (non-fatal):`, err?.message ?? err)
      }
    }

    console.log(
      _featureMode === 'full'
        ? `CFG Core | featureMode: full | platform: ${_platformSystemSlug}`
        : `CFG Core | featureMode: narrative`,
    )
  } catch (err) {
    console.warn('CFG Core | featureMode resolution failed (non-fatal):', err?.message ?? err)
  }
}

/* -------------------------------------------- */
/*  Platform Account Linking                     */
/* -------------------------------------------- */

/**
 * Link this Foundry user to their Core platform account.
 *
 * Auth source:
 *   - cfg-hosted Foundry: the same-origin session cookie identifies the
 *     caller automatically (no apiKey on the request).
 *   - Self-hosted Foundry: the world-scoped apiKey set by the pair flow
 *     (Module Settings → Crit-Fumble Link). When absent, the call is
 *     anonymous and silently no-ops.
 *
 * On success: stores platformUserId in a user flag and broadcasts the
 *   platformUserId↔foundryUserId mapping so other clients can build
 *   their identity maps.
 */
async function _linkPlatformUser(apiUrl, apiKey) {
  const api = new CoreAPIClient(apiUrl, apiKey)
  try {
    const data = await api.get('/api/v1/account/user')
    const platformUserId = data?.user?.id
    if (!platformUserId) return

    await game.user.setFlag(MODULE_ID, 'platformUserId', platformUserId)
    console.log(`CFG Core | Account linked: platform ${platformUserId} ↔ Foundry ${game.user.id}`)

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
  if (!_api || _linkedCampaignIds.length === 0) return

  try {
    // Module recommendations are per-system, not per-campaign — so we
    // only need to query ONE campaign's foundry config. Pick the first
    // linked one; the rest would return the same `defaultModules` set
    // for matching systems.
    const config = await _api.getFoundryConfig(_linkedCampaignIds[0])
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
