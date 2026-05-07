/**
 * CFG Session Tracker
 *
 * Bridges Foundry's GM-side session state to the Core platform session record.
 * Narrative-mode tool — works for all game systems.
 *
 * What it tracks:
 *   - Active session display: shows the Core session name + start time in the HUD
 *   - Session notes push: GM can push text from the Foundry journal / chat to Core
 *     session notes via a macro or scene control button
 *
 * What it does NOT do (full-mode only, not implemented here):
 *   - Character HP / stat synchronisation
 *   - Encounter outcome recording
 *   - Table-driven results posting
 *
 * Endpoints used:
 *   GET  /api/campaigns/{id}/sessions/active  → current session info
 */

'use strict'

const MODULE_ID = 'crit-fumble-core'
const LOG = 'CFG Core | Session |'
const POLL_MS = 60_000 // Re-check active session every 60 seconds

// ── SessionTracker ────────────────────────────────────────────────────────────

export class SessionTracker {
  /**
   * @param {import('./api-client.js').CoreAPIClient} apiClient
   * @param {string} campaignId
   */
  constructor(apiClient, campaignId) {
    this._api = apiClient
    this._campaignId = campaignId
    this._session = null // current active session or null
    this._pollHandle = null
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Begin polling for the active session. Call once on module ready. */
  start() {
    this._poll()
    this._pollHandle = setInterval(() => this._poll(), POLL_MS)
    console.log(`${LOG} Session tracker started`)
  }

  stop() {
    if (this._pollHandle) {
      clearInterval(this._pollHandle)
      this._pollHandle = null
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  async _poll() {
    try {
      const data = await this._api.getActiveSession(this._campaignId)
      this._session = data ?? null
      this._updateHud()
    } catch (err) {
      // 404 = no active session (normal), anything else = network error
      if (!err.message?.includes('not found') && !err.message?.includes('404')) {
        console.warn(`${LOG} Could not fetch active session:`, err.message)
      }
      this._session = null
      this._updateHud()
    }
  }

  /** Inject a small session badge into the Foundry navbar. */
  _updateHud() {
    const existing = document.getElementById('cfg-session-badge')
    if (existing) existing.remove()

    if (!this._session) return

    const nav = document.querySelector('#navigation')
    if (!nav) return

    const started = this._session.startedAt
      ? new Date(this._session.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : ''

    const badge = document.createElement('div')
    badge.id = 'cfg-session-badge'
    badge.className = 'cfg-session-badge'
    badge.title = `Core session: ${this._session.name ?? 'Active'}`
    badge.innerHTML = `<span class="cfg-session-dot"></span><span class="cfg-session-label">${this._session.name ?? 'Session'}</span>${started ? `<span class="cfg-session-time">${started}</span>` : ''}`
    nav.appendChild(badge)
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** @returns {object|null} The current active Core session, or null. */
  getSession() {
    return this._session
  }

  /** Force an immediate refresh. */
  async refresh() {
    await this._poll()
  }
}

// ── Singleton helper ──────────────────────────────────────────────────────────

let _tracker = null

/**
 * Initialize the session tracker. Should be called once on module ready.
 * @param {import('./api-client.js').CoreAPIClient} api
 * @param {string} campaignId
 */
export function initSessionTracker(api, campaignId) {
  if (_tracker) _tracker.stop()
  _tracker = new SessionTracker(api, campaignId)
  _tracker.start()
  return _tracker
}

/** @returns {SessionTracker|null} */
export function getSessionTracker() {
  return _tracker
}
