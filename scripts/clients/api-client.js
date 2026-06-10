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
 *   await api.patch('/api/v1/player/campaigns/my-campaign/foundry', { foundrySystemId: 'dnd5e' })
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

  /** GET /api/campaigns/{id} */
  getCampaign(id) {
    return this.get(`/api/campaigns/${id}`)
  }

  /** GET /api/campaigns/{id}/foundry/config */
  getFoundryConfig(id) {
    return this.get(`/api/campaigns/${id}/foundry/config`)
  }

  /** PATCH /api/campaigns/{id}/foundry */
  updateFoundry(id, data) {
    return this.patch(`/api/campaigns/${id}/foundry`, data)
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
   * Returns all FoundryActorSync records for the campaign (GM only).
   * @param {string} id — campaign ID
   * @returns {Promise<{ syncs: Array }>}
   */
  getActorSyncStatus(id) {
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

  // ── Parties ───────────────────────────────────────────────────────────────

  /** GET /api/campaigns/{id}/parties */
  getParties(id) {
    return this.get(`/api/campaigns/${id}/parties`)
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  /** GET /api/campaigns/{id}/sessions/active */
  getActiveSession(id) {
    return this.get(`/api/campaigns/${id}/sessions/active`)
  }

  /** GET /api/campaigns/{id}/sessions */
  getSessions(id) {
    return this.get(`/api/campaigns/${id}/sessions`)
  }

  // ── Quests ────────────────────────────────────────────────────────────────

  /** GET /api/campaigns/{id}/quests */
  getQuests(id, params = {}) {
    const qs = new URLSearchParams(params).toString()
    return this.get(`/api/campaigns/${id}/quests${qs ? `?${qs}` : ''}`)
  }

  /** PATCH /api/campaigns/{id}/quests/{questId} */
  updateQuest(campaignId, questId, data) {
    return this.patch(`/api/campaigns/${campaignId}/quests/${questId}`, data)
  }

  // ── Voice ─────────────────────────────────────────────────────────────────

  /** POST /api/campaigns/{id}/stream/webrtc/join — returns { token, url, roomName } */
  joinVoice(id) {
    return this.post(`/api/campaigns/${id}/stream/webrtc/join`, {})
  }

  // ── Journal ───────────────────────────────────────────────────────────────

  /** GET /api/campaigns/{id}/journal */
  getJournal(id) {
    return this.get(`/api/campaigns/${id}/journal`)
  }

  // ── GM Assist ─────────────────────────────────────────────────────────────

  /**
   * POST /api/campaigns/{id}/gm-assist
   * @param {string} id  — campaign ID
   * @param {string} prompt
   * @returns {Promise<{response: string}>}
   */
  gmAssist(id, prompt) {
    return this.post(`/api/campaigns/${id}/gm-assist`, { prompt })
  }
}
