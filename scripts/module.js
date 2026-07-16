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
import { JournalPullSync } from './services/journal-pull-sync.js'
import { WorldActorSnapshot } from './services/world-actor-snapshot.js'
import { CharacterSyncManager } from './services/character-sync.js'
import { CharacterPullSync } from './services/character-pull-sync.js'
import { Overlay3D } from './services/overlay-3d.js'

/* -------------------------------------------- */
/*  Module-level State                           */
/* -------------------------------------------- */

const MODULE_ID = 'crit-fumble-core'
const MODULE_VERSION = '2.13.0'

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
/** @type {JournalPullSync|null} */
let _journalPullSync = null

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

  // Host-environment detection (#699): when Foundry is cfg-hosted, the plugin
  // fetches its installation host key programmatically and stores it as the
  // Bearer `apiKey` setting. That runs in the `ready` hook (awaited, before the
  // API client is built) — see `applyHostedContext()` — so settings are live and
  // the key is in place before the first heartbeat. Self-hosted / third-party
  // Foundry uses the original pair-button flow inside the menu.
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
/*  Wall Config — a "3D Rendering" texture section  */
/* -------------------------------------------- */

// A texture for the Crit-Fumble 3D view, on ANY wall segment (walls AND doors) —
// independent of Foundry's door-animation (whose texture is tied to the animation type
// and, for non-doors, is purged on save). Stored in our module FLAG. The 3D viewer uses
// this as the base render texture, falling back to the native door `animation.texture`.
Hooks.on('renderWallConfig', (app, element) => {
  try {
    const doc = app?.document
    if (!doc) return
    const root = element instanceof HTMLElement ? element : element?.[0]
    const form = root?.querySelector?.('form') || root
    if (!form || form.querySelector('.cfg-3d-render')) return // already injected
    const cfg = doc.flags?.['crit-fumble-core'] || {}
    const tex = cfg.texture || ''
    const color = cfg.color || ''
    const scale = cfg.tileScale != null && cfg.tileScale !== '' ? cfg.tileScale : ''

    const fs = document.createElement('fieldset')
    fs.className = 'cfg-3d-render'
    fs.innerHTML =
      '<legend>3D Rendering</legend>' +
      '<div class="form-group"><label>Texture</label><div class="form-fields">' +
      `<file-picker name="flags.crit-fumble-core.texture" type="imagevideo" value="${tex}"></file-picker>` +
      '</div></div>' +
      '<div class="form-group"><label>Flip Texture</label><div class="form-fields">' +
      `<input type="checkbox" name="flags.crit-fumble-core.flip"${cfg.flip ? ' checked' : ''}>` +
      '</div></div>' +
      '<div class="form-group"><label>Tile Scale</label><div class="form-fields">' +
      `<input type="number" name="flags.crit-fumble-core.tileScale" value="${scale}" step="0.25" min="0" placeholder="1">` +
      '<p class="hint">Texture repeats per grid square. Blank = 1.</p>' +
      '</div></div>' +
      '<div class="form-group"><label>Wall Color</label><div class="form-fields">' +
      `<color-picker name="flags.crit-fumble-core.color" value="${color}"></color-picker>` +
      '<p class="hint">Used when no texture is set. Blank = default.</p>' +
      '</div></div>'

    // Insert INSIDE the scrollable content (after the last fieldset), not after the sticky
    // footer — otherwise it falls below the scroll region and can't be reached.
    const fieldsets = form.querySelectorAll('fieldset')
    const last = fieldsets[fieldsets.length - 1]
    if (last) last.after(fs)
    else form.appendChild(fs)
  } catch (e) {
    console.warn('CFG Core | 3D-render section injection failed', e)
  }
})

/* -------------------------------------------- */
/*  Scene / Level 3D wall DEFAULTS              */
/* -------------------------------------------- */

// Scene-wide and per-level default wall texture/colour/tiling for the 3D view, so a GM
// sets them once instead of on every segment. Stored in the same module flag namespace
// on the Scene and Level documents (`wallTexture`/`wallColor`/`wallTileScale`); the 3D
// producer resolves the cascade wall-flag → level default → scene default.
function cfg3dDefaultsFieldset(cfg) {
  const tex = cfg.wallTexture || ''
  const color = cfg.wallColor || ''
  const scale = cfg.wallTileScale != null && cfg.wallTileScale !== '' ? cfg.wallTileScale : ''
  const fs = document.createElement('fieldset')
  fs.className = 'cfg-3d-defaults'
  fs.innerHTML =
    '<legend>3D Wall Defaults</legend>' +
    '<p class="hint">Applied to walls that have no 3D texture/colour of their own. A per-level default overrides the scene default.</p>' +
    '<div class="form-group"><label>Wall Texture</label><div class="form-fields">' +
    `<file-picker name="flags.crit-fumble-core.wallTexture" type="imagevideo" value="${tex}"></file-picker>` +
    '</div></div>' +
    '<div class="form-group"><label>Tile Scale</label><div class="form-fields">' +
    `<input type="number" name="flags.crit-fumble-core.wallTileScale" value="${scale}" step="0.25" min="0" placeholder="1">` +
    '<p class="hint">Texture repeats per grid square. Blank = 1.</p>' +
    '</div></div>' +
    '<div class="form-group"><label>Wall Color</label><div class="form-fields">' +
    `<color-picker name="flags.crit-fumble-core.wallColor" value="${color}"></color-picker>` +
    '<p class="hint">Used when no texture is set. Blank = default.</p>' +
    '</div></div>'
  return fs
}

// Per-level defaults — the Level edit dialog (Scene → Levels → edit a level).
Hooks.on('renderLevelConfig', (app, element) => {
  try {
    const doc = app?.document
    if (!doc) return
    const root = element instanceof HTMLElement ? element : element?.[0]
    const form = root?.querySelector?.('form') || root
    if (!form || form.querySelector('.cfg-3d-defaults')) return
    const fs = cfg3dDefaultsFieldset(doc.flags?.['crit-fumble-core'] || {})
    const fieldsets = form.querySelectorAll('fieldset')
    const last = fieldsets[fieldsets.length - 1]
    if (last) last.after(fs)
    else form.appendChild(fs)
  } catch (e) {
    console.warn('CFG Core | level 3D-defaults injection failed', e)
  }
})

// Scene-wide defaults — appended to the Scene config Levels tab. That tab re-renders
// on level add/remove, so this re-injects (guarded) each time.
Hooks.on('renderSceneConfig', (app, element) => {
  try {
    const doc = app?.document
    if (!doc) return
    // GM / Assistant GM only (builders) — the 3D defaults menu, for now.
    if ((game?.user?.role ?? 0) < (globalThis.CONST?.USER_ROLES?.ASSISTANT ?? 3)) return
    const root = element instanceof HTMLElement ? element : element?.[0]
    const tab = root?.querySelector?.('.tab[data-tab="levels"]')
    if (!tab || tab.querySelector('.cfg-3d-defaults')) return
    tab.appendChild(cfg3dDefaultsFieldset(doc.flags?.['crit-fumble-core'] || {}))
  } catch (e) {
    console.warn('CFG Core | scene 3D-defaults injection failed', e)
  }
})

// Region → 3D terrain. A region renders as a flat-topped terrain tier in the 3D view when
// "Render as 3D terrain" is on. All fields are OPTIONAL: surface defaults to the region's
// native Elevation → Bottom, base to sea level (0), colour to the region's own colour.
// Injected into the Placement tab (which already holds Elevation).
Hooks.on('renderRegionConfig', (app, element) => {
  try {
    const doc = app?.document
    if (!doc) return
    // GM / Assistant GM only. Region config is owner-gated by Foundry, but gate the 3D
    // Terrain menu to builders explicitly (for now — config overrides are a follow-up).
    if ((game?.user?.role ?? 0) < (globalThis.CONST?.USER_ROLES?.ASSISTANT ?? 3)) return
    const root = element instanceof HTMLElement ? element : element?.[0]
    const tab = root?.querySelector?.('.tab[data-tab="placement"]')
    if (!tab || tab.querySelector('.cfg-3d-terrain')) return
    const cfg = doc.flags?.['crit-fumble-core'] || {}
    const num = (v) => (v != null && v !== '' ? v : '')
    const fs = document.createElement('fieldset')
    fs.className = 'cfg-3d-terrain'
    fs.innerHTML =
      '<legend>3D Terrain</legend>' +
      '<div class="form-group"><label>Render as 3D terrain</label><div class="form-fields">' +
      `<input type="checkbox" name="flags.crit-fumble-core.terrain"${cfg.terrain ? ' checked' : ''}>` +
      '</div><p class="hint">Draw this region as a flat-topped terrain tier in the 3D view.</p></div>' +
      '<div class="form-group"><label>Surface Elevation</label><div class="form-fields">' +
      `<input type="number" name="flags.crit-fumble-core.surface" value="${num(cfg.surface)}" step="0.5" placeholder="Elevation → Bottom">` +
      '</div><p class="hint">Standable top of the tier. Blank = the region\'s Bottom elevation.</p></div>' +
      '<div class="form-group"><label>Base Elevation</label><div class="form-fields">' +
      `<input type="number" name="flags.crit-fumble-core.base" value="${num(cfg.base)}" step="0.5" placeholder="0">` +
      '</div><p class="hint">The skirt drops (or rises) to here. Blank = 0 (sea level).</p></div>' +
      '<div class="form-group"><label>Terrain Color</label><div class="form-fields">' +
      `<color-picker name="flags.crit-fumble-core.color" value="${cfg.color || ''}"></color-picker>` +
      '</div><p class="hint">Blank = the region\'s own colour.</p></div>'
    tab.appendChild(fs)
  } catch (e) {
    console.warn('CFG Core | region 3D-terrain injection failed', e)
  }
})

// Token HUD → "Character View": the player's (and everyone's) token-contextual entry to
// the 3D view, looking THROUGH the selected token. Shown only on a token the user OWNS and
// has vision through (GMs/asst-GMs bypass the vision requirement). This is the first 3D
// option exposed to players — Free Camera + the toolbar stay builder-only.
Hooks.on('renderTokenHUD', (hud, element, _data) => {
  try {
    const token = hud?.object
    const doc = token?.document
    if (!doc || !token.isOwner) return
    const isBuilder = (game?.user?.role ?? 0) >= (globalThis.CONST?.USER_ROLES?.ASSISTANT ?? 3)
    const hasVision = !!doc.sight?.enabled
    if (!isBuilder && !hasVision) return // players need a token they can see through
    const root = element instanceof HTMLElement ? element : element?.[0]
    if (!root) return
    const col = root.querySelector('.col.right') || root.querySelector('.col.left') || root.querySelector('.control-icons') || root
    if (col.querySelector('.cfg-3d-charview')) return
    const BADGE = (t) => `<b class="cfg-3d-badge" style="font-weight:700;font-size:0.85em;letter-spacing:-0.5px">${t}</b>`
    const api = window.CFGCore?.overlay3D
    // Character view LOCKS on its subject; this token's HUD button either EXITS (if this IS
    // the subject) or ENTERS/switches character view onto this token.
    const isSubject = (api?.getViewMode?.() ?? '2d') === 'firstperson' && api?.getSubjectId?.() === doc.id
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'control-icon cfg-3d-charview'
    btn.dataset.tooltip = isSubject ? 'Exit 3D View — back to the normal map' : '3D View — see the scene in 3D through this token'
    btn.setAttribute('aria-label', isSubject ? 'Exit 3D View' : '3D View')
    btn.innerHTML = isSubject ? BADGE('2D') : BADGE('3D') // shows the mode you'll switch TO
    btn.addEventListener('click', async (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      if (btn.classList.contains('cfg-3d-loading')) return // already switching
      if (isSubject) {
        // Right-clicked the focused character → toggle 3D off, back to the normal Foundry map.
        try {
          await api?.setViewMode?.('2d')
        } catch (err) {
          console.warn('CFG Core | exit 3D View failed', err)
        }
        return
      }
      btn.classList.add('cfg-3d-loading')
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>' // loading state — not hung
      try {
        token.control({ releaseOthers: true })
      } catch {
        /* permission — ignore */
      }
      try {
        await api?.setViewMode?.('firstperson')
      } catch (err) {
        console.warn('CFG Core | 3D View from token HUD failed', err)
      } finally {
        btn.classList.remove('cfg-3d-loading')
        btn.innerHTML = BADGE('3D')
      }
    })
    // Right column, just ABOVE the hide/vision (eye) button.
    const eye = col.querySelector('.fa-eye')?.closest('button, .control-icon')
    if (eye) col.insertBefore(btn, eye)
    else col.prepend(btn)
  } catch (e) {
    console.warn('CFG Core | token-HUD Character View injection failed', e)
  }
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

  // Programmatic pairing: for cfg-hosted Foundry, fetch + store the installation
  // host key (Bearer) BEFORE building the API client, so the heartbeats
  // authenticate as the installation. Owner-scoped on the server; a non-owner GM
  // gets no key and `applyHostedContext` clears any stale one → session fallback.
  // Awaited so the setting is live before the first heartbeat fires below.
  if (getHostKind() === 'cfg-hosted') {
    try {
      await applyHostedContext()
    } catch (err) {
      console.warn('CFG Core | applyHostedContext failed (non-fatal, using session auth):', err?.message || err)
    }
  }

  const apiUrl = game.settings.get(MODULE_ID, 'coreApiUrl')
  // Both hosting modes read the same stored key: cfg-hosted gets an installation
  // key from `applyHostedContext` (programmatic pairing) or, if that couldn't mint
  // one, an empty value → session-cookie auth (same-origin). Self-hosted gets its
  // paired key. An empty/absent setting → null → session-cookie auth.
  const apiKey = game.settings.get(MODULE_ID, 'apiKey') || null

  // apiKey set → Bearer token (installation key or self-hosted pair). Null →
  // same-origin session-cookie auth (cfg-hosted non-owner GM fallback).
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

  // Core→Foundry party-journal sync (#184) — pull the platform journal entries
  // whose doc differs from what this world last held and write them in, so a note
  // written in PlayTable shows up at the table. GM-only (creating documents and
  // setting ownership are GM-only); the single-reporter election lives in the
  // class. Gated on the INSTALLATION id specifically — unlike the actor mirror
  // above, these endpoints are installation-scoped and resolve the world by
  // (hostingInstallationId, nativeIdentifier), which a paired self-hosted world
  // has no row for. Self-hosted journal sync needs its own path (#184 follow-up).
  if (heartbeatInstallId && game.user.isGM) {
    _journalPullSync = new JournalPullSync(_api, heartbeatInstallId)
    _journalPullSync.start()
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
      // `installId` comes from the URL segment, which post-#162 can be EITHER the
      // installation cuid or its slug (the proxy resolves by id then slug). Match
      // on either form so slug-hosted worlds still resolve their linked campaigns —
      // otherwise the write-back pull-loop never fires (cfs#17 #147).
      const matches = (c.linkedWorlds ?? []).some(
        (l) =>
          (l.installationId === installId || (l.installationSlug && l.installationSlug === installId)) &&
          l.worldId === worldId,
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
