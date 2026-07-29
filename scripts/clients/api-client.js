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
    const { timeout: _t, retries: _r, binary: _b, ...fetchOpts } = options

    // Binary requests (sourcebook page images) carry no JSON Content-Type — on a
    // self-hosted (cross-origin) install that header forces a CORS preflight for
    // every page flip, and there is no body for it to describe.
    const headers = {
      ...(options.binary ? {} : { 'Content-Type': 'application/json' }),
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

  /**
   * GET an endpoint that streams bytes (sourcebook page WebPs, cs#212) and return the
   * Blob. Errors still flow through the friendly JSON error path — the server answers
   * non-2xx with a JSON body even on binary routes.
   */
  async getBinary(endpoint, opts = {}) {
    const res = await this._request(endpoint, {
      ...opts,
      method: 'GET',
      binary: true,
      headers: { Accept: 'image/webp,*/*', ...(opts.headers ?? {}) },
    })
    if (!res.ok) return this._parse(res)
    return res.blob()
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

  // ── Foundry character sync — REMOVED (fp#46) ──────────────────────────────
  //
  // getSyncRecords / registerActorMapping / pushActorSync drove the campaign-keyed
  // FoundryActorSync pull-loop. That loop could only UPDATE an actor that already
  // existed, so a PlayTable-created character never reached the table; it was replaced
  // by the world-keyed desired-state sync in actor-pull-sync.js (getActorSyncPlan /
  // ackActorSync below).
  //
  // The server still SERVES those routes for plugin versions in the field, which carry
  // their own copy of this client. They retire together once no old-endpoint traffic
  // remains.

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
   * POST /api/v1/foundry/worlds/{worldId}/rolltables — mirror the world's RollTable documents
   * so PlayTable can list and edit them (dt#249). Same body shape as the macro push: a batch of
   * `table.toObject()` snapshots (embedded results included), and/or a reconcile signal.
   *
   * @param {{ tables?: Array, reconcile?: boolean, keepTableIds?: string[] }} body
   */
  pushWorldRollTables(worldId, body) {
    return this.post(`/api/v1/foundry/worlds/${encodeURIComponent(worldId)}/rolltables`, body)
  }

  /**
   * POST /api/v1/foundry/worlds/{worldId}/items — mirror the world's STANDALONE Item
   * directory (dt#250). Full `item.toObject()` snapshots, embedded effects included;
   * actor-embedded items ride the actor push, not this one.
   *
   * @param {{ items?: Array, reconcile?: boolean, keepItemIds?: string[] }} body
   */
  pushWorldItems(worldId, body) {
    return this.post(`/api/v1/foundry/worlds/${encodeURIComponent(worldId)}/items`, body)
  }

  /**
   * POST /api/v1/foundry/worlds/{worldId}/playlists — mirror the world's Playlist documents
   * (dt#249). Full `playlist.toObject()` snapshots, embedded sounds included; the server
   * strips the dangerous playback fields (`playing`/`pausedTime`) at ingest.
   *
   * @param {{ playlists?: Array, reconcile?: boolean, keepPlaylistIds?: string[] }} body
   */
  pushWorldPlaylists(worldId, body) {
    return this.post(`/api/v1/foundry/worlds/${encodeURIComponent(worldId)}/playlists`, body)
  }

  /**
   * POST /api/v1/foundry/worlds/{worldId}/cards — mirror the world's card stacks (dt#249).
   * Full `cards.toObject()` snapshots, embedded cards included.
   *
   * @param {{ stacks?: Array, reconcile?: boolean, keepStackIds?: string[] }} body
   */
  pushWorldCards(worldId, body) {
    return this.post(`/api/v1/foundry/worlds/${encodeURIComponent(worldId)}/cards`, body)
  }

  /**
   * POST /api/v1/foundry/worlds/{worldId}/scenes — mirror the world's Scene documents so the
   * platform can show them in PlayTable and render the offline viewer WHILE the world is running
   * (the LevelDB read is locked then). Same body shape as the actor push: a batch of
   * `scene.toObject()` snapshots, and/or a reconcile signal.
   *
   * @param {{ scenes?: Array, reconcile?: boolean, keepSceneIds?: string[] }} body
   */
  pushWorldScenes(worldId, body) {
    return this.post(`/api/v1/foundry/worlds/${encodeURIComponent(worldId)}/scenes`, body)
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

  // ── Actor sync (platform → this world) — fp#46 ────────────────────────────

  /**
   * GET /api/v1/installations/{installationId}/foundry/actor-sync?world={worldId}&system={systemId}
   * The platform characters whose actor doc DIFFERS from what this world was last
   * confirmed to hold — creates included. Empty is the normal steady state.
   *
   * `system` is REQUIRED and is `game.system.id`: an Actor carries a `system` block that
   * fails validation in a world running a different system, so the server needs to know
   * which world it is planning for. A JournalEntry has no equivalent, which is why the
   * journal endpoint next door takes no system.
   *
   * @param {string} installationId
   * @param {string} worldId — Foundry world folder (`game.world.id`)
   * @param {string} systemId — `game.system.id`
   * @returns {Promise<{ data: Array<{ characterId: string|null, foundryActorId: string, everPushed: boolean, systemId: string, claimedAt: string|null, docData: object }> }>}
   */
  getActorSyncPlan(installationId, worldId, systemId) {
    return this.get(
      `/api/v1/installations/${installationId}/foundry/actor-sync` +
        `?world=${encodeURIComponent(worldId)}&system=${encodeURIComponent(systemId)}`,
    )
  }

  /**
   * POST /api/v1/installations/{installationId}/foundry/actor-sync/ack
   * Report what was actually written. `docData` MUST be the doc we wrote, not the one we
   * planned to: the server baselines against it, and if the sheet changed platform-side
   * between the pull and this ack, echoing keeps the baseline honest.
   *
   * `code` carries the machine-readable refusal: `world_deleted` parks the row (the GM
   * deleted the actor — do not resurrect it), `system_mismatch` marks it errored.
   * `claimedAt` is echoed so the server only drains a GM platform-edit claim that has not
   * been re-staked since the plan was pulled.
   *
   * @param {Array<{ characterId: string|null, foundryActorId: string, ok: boolean, docData?: object, error?: string, code?: string, claimedAt?: string }>} results
   */
  ackActorSync(installationId, worldId, systemId, results) {
    return this.post(`/api/v1/installations/${installationId}/foundry/actor-sync/ack`, {
      world: worldId,
      system: systemId,
      results,
    })
  }

  // ── Macro write-back (platform → this world) — dt#245 ─────────────────────

  /**
   * GET /api/v1/installations/{installationId}/foundry/macro-sync?world={worldId}
   * The macros a GM edited in PlayTable that no write-back has drained yet. Empty is the
   * normal steady state.
   *
   * No `system` parameter, unlike the actor endpoint: a Macro carries no `system` block, so
   * there is no foreign-system doc to refuse.
   *
   * @returns {Promise<{ data: Array<{ foundryDocId: string, everPushed: boolean, claimedAt: string|null, docData: object, removedPaths: string[] }> }>}
   */
  getMacroSyncPlan(installationId, worldId) {
    return this.get(`/api/v1/installations/${installationId}/foundry/macro-sync?world=${encodeURIComponent(worldId)}`)
  }

  // ── Module-pack import queue (dt#185) ─────────────────────────────────────

  /**
   * GET /api/v1/installations/{installationId}/foundry/module-pack-import?world={worldId}
   * The GM's pending import requests for this world — module/system packs to read via
   * `game.packs` and push back. Empty is the normal steady state.
   *
   * @returns {Promise<{ data: Array<{ requestId: string, packageId: string, packName: string }> }>}
   */
  getModulePackImportPlan(installationId, worldId) {
    return this.get(
      `/api/v1/installations/${installationId}/foundry/module-pack-import?world=${encodeURIComponent(worldId)}`,
    )
  }

  /**
   * POST /api/v1/installations/{installationId}/foundry/module-pack-import/push
   * One batch of a pack's documents (max 500 per push; `done: true` on the final batch
   * completes the request). Pass `error` instead to park a request whose pack cannot be
   * read (missing in this world, etc.). The server re-checks the licensing allowlist on
   * every push — this client is a courier, not the gate.
   *
   * @param {{ world: string, requestId: string, entries: Array, folders?: Array, done: boolean, error?: string|null }} body
   */
  pushModulePackImport(installationId, body) {
    return this.post(`/api/v1/installations/${installationId}/foundry/module-pack-import/push`, body)
  }

  /**
   * POST /api/v1/installations/{installationId}/foundry/macro-sync/ack
   *
   * `claimedAt` is echoed so the server only drains a claim that has not been re-staked
   * since the plan was pulled — a GM who edited the macro again mid-tick must not lose it.
   * `code: 'world_deleted'` releases the claim instead of retrying into a macro that no
   * longer exists.
   *
   * @param {Array<{ foundryMacroId: string, ok: boolean, error?: string, code?: string, claimedAt?: string }>} results
   */
  ackMacroSync(installationId, worldId, results) {
    return this.post(`/api/v1/installations/${installationId}/foundry/macro-sync/ack`, { world: worldId, results })
  }

  // ── RollTable write-back (platform → this world) — dt#249 ─────────────────

  /**
   * GET /api/v1/installations/{installationId}/foundry/rolltable-sync?world={worldId}
   * The roll tables a GM edited in PlayTable that no write-back has drained yet. Empty is the
   * normal steady state. No `system` parameter — a RollTable carries no `system` block.
   *
   * @returns {Promise<{ data: Array<{ foundryRollTableId: string, everPushed: boolean, claimedAt: string|null, docData: object, removedPaths: string[] }> }>}
   */
  getRollTableSyncPlan(installationId, worldId) {
    return this.get(`/api/v1/installations/${installationId}/foundry/rolltable-sync?world=${encodeURIComponent(worldId)}`)
  }

  /**
   * POST /api/v1/installations/{installationId}/foundry/rolltable-sync/ack
   *
   * `claimedAt` is echoed so the server only drains a claim that has not been re-staked
   * since the plan was pulled. `code: 'world_deleted'` releases the claim instead of
   * retrying into a table that no longer exists.
   *
   * @param {Array<{ foundryRollTableId: string, ok: boolean, error?: string, code?: string, claimedAt?: string }>} results
   */
  ackRollTableSync(installationId, worldId, results) {
    return this.post(`/api/v1/installations/${installationId}/foundry/rolltable-sync/ack`, { world: worldId, results })
  }

  // ── Standalone Item write-back (platform → this world) — dt#250 ───────────

  /**
   * GET /api/v1/installations/{installationId}/foundry/item-sync?world={worldId}
   * The standalone items a GM edited in PlayTable that no write-back has drained yet.
   * No `system` parameter — every doc is a same-world round-trip.
   *
   * @returns {Promise<{ data: Array<{ foundryItemId: string, everPushed: boolean, claimedAt: string|null, docData: object, removedPaths: string[] }> }>}
   */
  getItemSyncPlan(installationId, worldId) {
    return this.get(`/api/v1/installations/${installationId}/foundry/item-sync?world=${encodeURIComponent(worldId)}`)
  }

  /**
   * POST /api/v1/installations/{installationId}/foundry/item-sync/ack
   *
   * `claimedAt` is echoed so the server only drains a claim that has not been re-staked
   * since the plan was pulled. `code: 'world_deleted'` releases the claim instead of
   * retrying into an item that no longer exists.
   *
   * @param {Array<{ foundryItemId: string, ok: boolean, error?: string, code?: string, claimedAt?: string }>} results
   */
  ackItemSync(installationId, worldId, results) {
    return this.post(`/api/v1/installations/${installationId}/foundry/item-sync/ack`, { world: worldId, results })
  }

  // ── Folder write-back (platform → this world) — dt#250 ────────────────────

  /**
   * GET /api/v1/installations/{installationId}/foundry/folder-sync?world={worldId}
   * The folders a GM created/edited/deleted in PlayTable that no write-back has drained
   * yet. Creates/edits carry docData; `deleted: true` items carry none.
   *
   * @returns {Promise<{ data: Array<{ foundryFolderId: string, everPushed: boolean, claimedAt: string|null, docData?: object, removedPaths: string[], deleted?: boolean }> }>}
   */
  getFolderSyncPlan(installationId, worldId) {
    return this.get(`/api/v1/installations/${installationId}/foundry/folder-sync?world=${encodeURIComponent(worldId)}`)
  }

  /**
   * POST /api/v1/installations/{installationId}/foundry/folder-sync/ack
   *
   * `claimedAt` is echoed so the server only drains a claim that has not been re-staked
   * since the plan was pulled; `deleted` is echoed so the server drains the right
   * lifecycle (a delete ack removes the row, an edit ack clears the claim).
   *
   * @param {Array<{ foundryFolderId: string, ok: boolean, error?: string, code?: string, claimedAt?: string, deleted?: boolean }>} results
   */
  ackFolderSync(installationId, worldId, results) {
    return this.post(`/api/v1/installations/${installationId}/foundry/folder-sync/ack`, { world: worldId, results })
  }

  // ── Playlist write-back (platform → this world) — dt#249 ──────────────────

  /**
   * GET /api/v1/installations/{installationId}/foundry/playlist-sync?world={worldId}
   * The playlists a GM edited in PlayTable that no write-back has drained yet.
   *
   * @returns {Promise<{ data: Array<{ foundryPlaylistId: string, everPushed: boolean, claimedAt: string|null, docData: object, removedPaths: string[] }> }>}
   */
  getPlaylistSyncPlan(installationId, worldId) {
    return this.get(`/api/v1/installations/${installationId}/foundry/playlist-sync?world=${encodeURIComponent(worldId)}`)
  }

  /**
   * POST /api/v1/installations/{installationId}/foundry/playlist-sync/ack
   *
   * @param {Array<{ foundryPlaylistId: string, ok: boolean, error?: string, code?: string, claimedAt?: string }>} results
   */
  ackPlaylistSync(installationId, worldId, results) {
    return this.post(`/api/v1/installations/${installationId}/foundry/playlist-sync/ack`, { world: worldId, results })
  }

  // ── Cards write-back (platform → this world) — dt#249 ─────────────────────

  /**
   * GET /api/v1/installations/{installationId}/foundry/cards-sync?world={worldId}
   * The card stacks a GM edited in PlayTable that no write-back has drained yet.
   *
   * @returns {Promise<{ data: Array<{ foundryCardsId: string, everPushed: boolean, claimedAt: string|null, docData: object, removedPaths: string[] }> }>}
   */
  getCardsSyncPlan(installationId, worldId) {
    return this.get(`/api/v1/installations/${installationId}/foundry/cards-sync?world=${encodeURIComponent(worldId)}`)
  }

  /**
   * POST /api/v1/installations/{installationId}/foundry/cards-sync/ack
   *
   * @param {Array<{ foundryCardsId: string, ok: boolean, error?: string, code?: string, claimedAt?: string }>} results
   */
  ackCardsSync(installationId, worldId, results) {
    return this.post(`/api/v1/installations/${installationId}/foundry/cards-sync/ack`, { world: worldId, results })
  }

  /**
   * POST /api/v1/foundry/worlds/{worldId}/journal — the world→platform journal leg (dt#247).
   *
   * NOT a mirror store: nothing is persisted for offline viewing. This exists solely so the
   * platform can answer the two questions its own push log cannot — is the entry still
   * there, and did the world edit it more recently than we did (cs#186).
   *
   * @param {string} worldId
   * @param {{ entries?: Array<object>, reconcile?: boolean, keepEntryIds?: string[] }} body
   */
  pushWorldJournal(worldId, body) {
    return this.post(`/api/v1/foundry/worlds/${worldId}/journal`, body)
  }

  // ── Scene sync (platform → this world) — dt#246 ───────────────────────────

  /**
   * GET /api/v1/installations/{installationId}/foundry/scene-sync?world={worldId}
   * Platform-authored scenes whose doc differs from what this world last held — creates
   * included. Empty is the normal steady state.
   *
   * NB the docs never carry `active`: it is writable through a plain update(), so pushing
   * it would change which scene every connected player is looking at. The server strips it.
   */
  getSceneSyncPlan(installationId, worldId) {
    return this.get(`/api/v1/installations/${installationId}/foundry/scene-sync?world=${encodeURIComponent(worldId)}`)
  }

  /**
   * POST /api/v1/installations/{installationId}/foundry/scene-sync/ack
   * @param {Array<{ sceneId: string|null, foundrySceneId: string, ok: boolean, docData?: object, error?: string, code?: string }>} results
   */
  ackSceneSync(installationId, worldId, results) {
    return this.post(`/api/v1/installations/${installationId}/foundry/scene-sync/ack`, { world: worldId, results })
  }
}
