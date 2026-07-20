/**
 * CFG Core API Client
 *
 * Handles all communication with the Core platform from within the FoundryVTT
 * container. Supports two authentication modes:
 *
 *   Core-hosted  — Foundry is embedded in the Core platform. Authentication uses
 *                  the browser's existing session cookie (credentials: 'include').
 *                  No API key needed; the session cookie is included automatically.
 *
 *   Self-hosted  — Foundry runs on the GM's own server. Authentication uses a
 *                  CFG API key (cfk_...) generated in the user's Core account
 *                  settings and stored as a Foundry world setting. The key is
 *                  sent as `Authorization: Bearer cfk_...` on every request.
 *
 * Usage:
 *   // Core-hosted (no key)
 *   const api = new CoreAPIClient('https://core.crit-fumble.com')
 *   // Self-hosted (API key)
 *   const api = new CoreAPIClient('https://core.crit-fumble.com', 'cfk_yourkey')
 *   const data = await api.get('/api/v1/player/campaigns/my-campaign/quests')
 *   const { foundry } = await api.getFoundryStatus('my-campaign') // featureMode, etc.
 */

'use strict'

const DEFAULT_TIMEOUT = 20_000 // 20 seconds
const MAX_RETRIES = 2

export class CoreAPIClient {
  /**
   * @param {string} baseUrl — e.g. 'https://core.crit-fumble.com'
   * @param {string|null} [apiKey] — CFG API key (cfk_...) for self-hosted mode; null for core-hosted
   */
  constructor(baseUrl, apiKey = null) {
    this.baseUrl = (baseUrl || 'https://core.crit-fumble.com').replace(/\/$/, '')
    this.apiKey = apiKey || null
  }

  // ── Request primitives ────────────────────────────────────────────────────

  /**
   * @param {string} endpoint
   * @param {RequestInit & { timeout?: number; retries?: number }} options
   * @returns {Promise<Response>}
   */
  async _request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`
    const timeout = options.timeout ?? DEFAULT_TIMEOUT
    const retries = options.retries ?? MAX_RETRIES
    const { timeout: _t, retries: _r, ...fetchOpts } = options

    const headers = {
      'Content-Type': 'application/json',
      ...(fetchOpts.headers ?? {}),
    }

    // Self-hosted: send API key as Bearer token; no session cookie needed.
    // Core-hosted: rely on session cookie via credentials: 'include'.
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`
    }

    let lastErr
    for (let attempt = 1; attempt <= retries; attempt++) {
      const controller = new AbortController()
      const timerId = setTimeout(() => controller.abort(), timeout)
      try {
        const res = await fetch(url, {
          ...fetchOpts,
          headers,
          ...(this.apiKey ? {} : { credentials: 'include' }),
          signal: controller.signal,
        })
        clearTimeout(timerId)
        return res
      } catch (err) {
        clearTimeout(timerId)
        lastErr = err
        if (attempt < retries && !controller.signal.aborted) {
          await new Promise((r) => setTimeout(r, 500 * attempt))
        }
      }
    }
    throw lastErr
  }

  /**
   * Parse response — throws a friendly Error on non-2xx.
   * @param {Response} res
   * @returns {Promise<any>}
   */
  async _parse(res) {
    let body
    try {
      body = await res.json()
    } catch {
      body = {}
    }

    if (res.ok) return body

    if (res.status === 401) {
      throw new Error(
        this.apiKey
          ? 'Invalid or expired CFG API key. Regenerate it in your Core account settings.'
          : 'Not logged in to Core. Open core.crit-fumble.com in your browser and sign in.',
      )
    }
    if (res.status === 403) throw new Error('You do not have permission for this action.')
    if (res.status === 404) throw new Error('Resource not found.')
    if (res.status === 429) throw new Error('Rate limited — please try again in a moment.')
    throw new Error(body?.error ?? `Core server error (HTTP ${res.status})`)
  }

  // ── Public request method (used by module internals) ─────────────────────────

  /** Generic fetch — parses response and throws on non-2xx. */
  async request(endpoint, options = {}) {
    return this._parse(await this._request(endpoint, options))
  }

  // ── HTTP verbs ────────────────────────────────────────────────────────────

  async get(endpoint, opts = {}) {
    return this._parse(await this._request(endpoint, { ...opts, method: 'GET' }))
  }
  async post(endpoint, body, opts = {}) {
    return this._parse(await this._request(endpoint, { ...opts, method: 'POST', body: JSON.stringify(body) }))
  }
  async patch(endpoint, body, opts = {}) {
    return this._parse(await this._request(endpoint, { ...opts, method: 'PATCH', body: JSON.stringify(body) }))
  }
  async del(endpoint, opts = {}) {
    return this._parse(await this._request(endpoint, { ...opts, method: 'DELETE' }))
  }

  // ── Campaign endpoints ────────────────────────────────────────────────────

  /** GET /api/v1/player/campaigns/{id} */
  getCampaign(id) {
    return this.get(`/api/v1/player/campaigns/${id}`)
  }

  /** GET /api/v1/player/campaigns/{id}/foundry/config */
  getFoundryConfig(id) {
    return this.get(`/api/v1/player/campaigns/${id}/foundry/config`)
  }

  /**
   * GET /api/v1/player/campaigns/{id}/foundry
   * Foundry integration status for a campaign — `featureMode`, `platformSystemSlug`,
   * `foundrySystemId`, `isLinked`, heartbeat. featureMode is derived server-side
   * from the campaign's configured game system; the plugin reads it (it is not
   * reported by PATCH — the old `/api/campaigns/{id}/foundry` PATCH was retired
   * along with the single-campaign model).
   */
  getFoundryStatus(id) {
    return this.get(`/api/v1/player/campaigns/${id}/foundry`)
  }

  // ── Characters ────────────────────────────────────────────────────────────

  /**
   * GET /api/v1/player/campaigns/{id}/characters
   * @param {string} id         — campaign ID
   * @param {{ role?: string }} [params]
   * @returns {Promise<{ playerCharacters: Array, summary: object }>}
   */
  getCampaignCharacters(id, params = {}) {
    const qs = new URLSearchParams(params).toString()
    return this.get(`/api/v1/player/campaigns/${id}/characters${qs ? `?${qs}` : ''}`)
  }

  // ── Foundry character sync ────────────────────────────────────────────────

  /**
   * GET /api/v1/player/campaigns/{id}/foundry/sync
   * Returns all FoundryActorSync records for the campaign (GM only). Each record
   * carries `{ id, foundryActorId, syncStatus, lastSyncFrom, character: { id, name,
   * characterRole, ownerId } }` — the pull-loop reads `syncStatus === 'pending'`
   * with `lastSyncFrom === 'core'` to find platform edits awaiting apply.
   * @param {string} id — campaign ID
   * @returns {Promise<{ syncs: Array }>}
   */
  getSyncRecords(id) {
    return this.get(`/api/v1/player/campaigns/${id}/foundry/sync`)
  }

  /**
   * POST /api/v1/player/campaigns/{id}/foundry/sync/actors
   * Register a Core character ↔ Foundry actor mapping.
   * Called once after creating a new Foundry actor from a Core character so that
   * future Foundry→Core pushes can match by foundryActorId.
   *
   * Returns the initial systemUpdate + itemUpdates the plugin should apply
   * to the actor to seed it with Core's current values.
   *
   * @param {string} id                — campaign ID
   * @param {string} characterId       — Core character ID (crit-fumble-core.characterId flag)
   * @param {string} foundryActorId    — Foundry actor._id
   * @returns {Promise<{ syncId: string, characterId: string, foundryActorId: string, systemUpdate: object, itemUpdates: Array }>}
   */
  registerActorMapping(id, characterId, foundryActorId) {
    return this.post(`/api/v1/player/campaigns/${id}/foundry/sync/actors`, { characterId, foundryActorId })
  }

  /**
   * POST /api/v1/player/campaigns/{id}/foundry/sync
   * Push updated actor data from Foundry to Core.
   * Core detects conflicts and either applies the changes or returns conflict records
   * for the GM to resolve.
   *
   * @param {string} id                — campaign ID
   * @param {Array}  actors            — array of FoundryActorData objects
   * @returns {Promise<{ synced: number, conflict: number, unmapped: number, errors: number, results: Array }>}
   */
  pushActorSync(id, actors) {
    return this.post(`/api/v1/player/campaigns/${id}/foundry/sync`, { actors })
  }

  // ── Whole-world actor mirror (cfs#17) ───────────────────────────────────────

  /**
   * POST /api/v1/foundry/worlds/{worldId}/actors
   * Mirror the world's actors to the platform so they stay viewable when the
   * VTT is offline. Same auth as the world-status callback (installation key /
   * session-cookie fallback). Body modes combine: pass `actors` to upsert a
   * batch, and/or `{ reconcile: true, keepActorIds }` to drop stale rows.
   *
   * @param {string} worldId — Foundry world folder (game.world.id)
   * @param {{ systemId?: string|null, actors?: Array, reconcile?: boolean, keepActorIds?: string[] }} body
   * @returns {Promise<{ ok: boolean, upserted: number, linked: number, skipped: number, removed: number }>}
   */
  pushWorldActors(worldId, body) {
    return this.post(`/api/v1/foundry/worlds/${encodeURIComponent(worldId)}/actors`, body)
  }

  /**
   * POST /api/v1/foundry/worlds/{worldId}/macros — mirror the world's Macro documents so
   * PlayTable can list, edit and hotbar-assign them (dt#214). Same body shape as the actor push:
   * a batch of `macro.toObject()` snapshots, and/or a reconcile signal.
   *
   * @param {{ macros?: Array, reconcile?: boolean, keepMacroIds?: string[] }} body
   */
  pushWorldMacros(worldId, body) {
    return this.post(`/api/v1/foundry/worlds/${encodeURIComponent(worldId)}/macros`, body)
  }

  /**
   * POST /api/v1/foundry/worlds/{worldId}/folders — mirror the world's Folder
   * documents so the platform can render the actor directory as a TREE (cs#195).
   *
   * Actors already carry their folder id (we send `actor.toObject()`), so this
   * supplies the missing half: what each folder is called and where it sits.
   * Same body shape as the actor push — { folders } and/or
   * { reconcile, keepFolderIds }.
   */
  pushWorldFolders(worldId, body) {
    return this.post(`/api/v1/foundry/worlds/${encodeURIComponent(worldId)}/folders`, body)
  }

  /**
   * POST /api/v1/foundry/worlds/{worldId}/compendiums — mirror the world's GM-AUTHORED
   * compendium packs so their documents are readable (and later editable) on the platform (dt#185).
   *
   * ONLY packs Foundry marks `packageType === 'world'` may be sent. Module packs (WotC books,
   * Plutonium, …) belong to their publisher, and the platform stores mirrored packs with an
   * `origin` that asserts provenance — sending one would make that claim false. The server
   * re-checks and refuses, but the filter belongs here too: do not widen it.
   *
   * Same body modes as the actor push — { packs } to upsert, and/or
   * { reconcile: true, keepPackIds, keepEntryIdsByPack } to drop what the world no longer has.
   */
  pushWorldCompendiums(worldId, body) {
    return this.post(`/api/v1/foundry/worlds/${encodeURIComponent(worldId)}/compendiums`, body)
  }

  /**
   * GET /api/v1/foundry/worlds/{worldId}/compendiums/pending — platform edits queued for the live
   * world (dt#185 slice 3). Each entry carries `typeChanged`, because a type change cannot be
   * applied with update() and must be delete + create.
   */
  listPendingWorldCompendiums(worldId) {
    return this.get(`/api/v1/foundry/worlds/${encodeURIComponent(worldId)}/compendiums/pending`)
  }

  /** POST .../compendiums/drain — release the claim for entries the world accepted. */
  drainWorldCompendiums(worldId, body) {
    return this.post(`/api/v1/foundry/worlds/${encodeURIComponent(worldId)}/compendiums/drain`, body)
  }

  // ── Parties ───────────────────────────────────────────────────────────────

  /** GET /api/v1/player/campaigns/{id}/parties */
  getParties(id) {
    return this.get(`/api/v1/player/campaigns/${id}/parties`)
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  /** GET /api/v1/player/campaigns/{id}/sessions/active */
  getActiveSession(id) {
    return this.get(`/api/v1/player/campaigns/${id}/sessions/active`)
  }

  /** GET /api/v1/player/campaigns/{id}/sessions */
  getSessions(id) {
    return this.get(`/api/v1/player/campaigns/${id}/sessions`)
  }

  // ── Quests ────────────────────────────────────────────────────────────────

  /** GET /api/v1/player/campaigns/{id}/quests */
  getQuests(id, params = {}) {
    const qs = new URLSearchParams(params).toString()
    return this.get(`/api/v1/player/campaigns/${id}/quests${qs ? `?${qs}` : ''}`)
  }

  /** PATCH /api/v1/player/campaigns/{id}/quests/{questId} */
  updateQuest(campaignId, questId, data) {
    return this.patch(`/api/v1/player/campaigns/${campaignId}/quests/${questId}`, data)
  }

  // ── Journal ───────────────────────────────────────────────────────────────

  /** GET /api/v1/player/campaigns/{id}/journal */
  getJournal(id) {
    return this.get(`/api/v1/player/campaigns/${id}/journal`)
  }

  // ── GM Assist ─────────────────────────────────────────────────────────────

  /**
   * POST /api/v1/player/campaigns/{id}/gm-assist
   * @param {string} id  — campaign ID
   * @param {string} prompt
   * @returns {Promise<{response: string}>}
   */
  gmAssist(id, prompt) {
    return this.post(`/api/v1/player/campaigns/${id}/gm-assist`, { prompt })
  }

  // ── Runtime player provisioning ───────────────────────────────────────────

  /**
   * GET /api/v1/installations/{installationId}/foundry/pending-provisions?world={worldId}
   * The reserved Foundry seats a connected GM must create so the proxy can SSO
   * invited players into the LIVE world (Foundry only lets a GM create User
   * docs). Owner-session / installation-key scoped.
   * @param {string} installationId
   * @param {string} worldId — Foundry world folder (`game.world.id`)
   * @returns {Promise<{ data: Array<{ nativeUserId: string, foundryUsername: string, role: number, password: string }> }>}
   */
  getPendingProvisions(installationId, worldId) {
    return this.get(
      `/api/v1/installations/${installationId}/foundry/pending-provisions?world=${encodeURIComponent(worldId)}`,
    )
  }

  /**
   * POST /api/v1/installations/{installationId}/foundry/pending-provisions/confirm
   * Mark a reserved seat provisioned once its Foundry User doc has been created;
   * this is what flips the proxy SSO gate on for that player.
   */
  confirmProvision(installationId, worldId, nativeUserId) {
    return this.post(`/api/v1/installations/${installationId}/foundry/pending-provisions/confirm`, {
      world: worldId,
      nativeUserId,
    })
  }

  // ── Journal sync (platform → this world) ──────────────────────────────────

  /**
   * GET /api/v1/installations/{installationId}/foundry/journal-sync?world={worldId}
   * The platform journal entries whose doc DIFFERS from what this world was last
   * confirmed to hold. Empty is the normal steady state — the server only returns
   * work, so a quiet tick costs one request and nothing else.
   * @param {string} installationId
   * @param {string} worldId — Foundry world folder (`game.world.id`)
   * @returns {Promise<{ data: Array<{ journalEntryId: string, foundryEntryId: string, partyId: string, docData: object }> }>}
   */
  getJournalSyncPlan(installationId, worldId) {
    return this.get(
      `/api/v1/installations/${installationId}/foundry/journal-sync?world=${encodeURIComponent(worldId)}`,
    )
  }

  /**
   * POST /api/v1/installations/{installationId}/foundry/journal-sync/ack
   * Report what was actually written. `docData` MUST be the doc we wrote, not the
   * one we planned to: the server baselines against it, and if the entry changed
   * platform-side between the pull and this ack, echoing keeps the baseline honest
   * about what really landed in the world.
   * @param {Array<{ journalEntryId: string, foundryEntryId: string, ok: boolean, docData?: object, error?: string }>} results
   */
  ackJournalSync(installationId, worldId, results) {
    return this.post(`/api/v1/installations/${installationId}/foundry/journal-sync/ack`, {
      world: worldId,
      results,
    })
  }
}
