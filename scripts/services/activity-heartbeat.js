/**
 * CFG Activity Heartbeat
 *
 * Reports this world's live active-user count to the Core platform on a
 * timer, so server-side idle automation (auto-shutdown after N minutes with
 * nobody connected) has a real signal instead of guessing from Discord
 * voice presence. The authoritative count is `game.users.active`, which
 * every connected client sees identically.
 *
 * Single-reporter election: Foundry modules run in every connected client,
 * so without coordination N browsers would each POST the same number. The
 * active user with the lexicographically smallest id is the designated
 * reporter; everyone else stays quiet. If that user disconnects, the next
 * one takes over on the following tick — no central coordination needed.
 *
 * Auth: posts through the shared CoreAPIClient, which attaches the world's
 * pre-minted installation API key (cfg-hosted) or the paired key
 * (self-hosted). The Core endpoint is owner-scoped, so any connected
 * client's report is accepted — the key identifies the installation, not
 * the reporting user.
 *
 * Endpoint: POST /api/v1/installations/{installationId}/activity
 */

'use strict'

const LOG = 'CFG Core | Activity |'
const HEARTBEAT_MS = 60_000 // Matches the server's 3-min staleness window.

// Matches SERVICE_GM_NATIVE_ID in cfg-core-server (admin-key.ts). The headless
// service-GM is role-4 but must be excluded from the reported counts: its
// presence must not keep the world alive (uptime billing), and it must not
// register as a human GM (which would suppress its own provisioning trigger).
const SERVICE_GM_ID = 'CFGServiceGM0000'

export class ActivityHeartbeat {
  /**
   * @param {import('../clients/api-client.js').CoreAPIClient} apiClient
   * @param {string} installationId
   */
  constructor(apiClient, installationId) {
    this._api = apiClient
    this._installationId = installationId
    this._handle = null
  }

  /** Begin the heartbeat. Call once on module ready (cfg-hosted/paired only). */
  start() {
    if (!this._installationId) return
    this._tick()
    this._handle = setInterval(() => this._tick(), HEARTBEAT_MS)
    console.log(`${LOG} heartbeat started for installation ${this._installationId}`)
  }

  stop() {
    if (this._handle) {
      clearInterval(this._handle)
      this._handle = null
    }
  }

  /** Am I the elected reporter for this tick? Smallest active HUMAN id wins. The
   *  service-GM is excluded so it never becomes the reporter — when only it is
   *  connected there is intentionally NO heartbeat, so the world's activity goes
   *  stale and idles out rather than the service-GM keeping it alive. */
  _isReporter() {
    const activeIds = game.users.filter((u) => u.active && u.id !== SERVICE_GM_ID).map((u) => u.id)
    if (activeIds.length === 0) return false
    activeIds.sort()
    return game.user?.id === activeIds[0]
  }

  async _tick() {
    try {
      if (!this._isReporter()) return
      // Count HUMANS only — exclude the headless service-GM from both signals.
      const humans = game.users.filter((u) => u.active && u.id !== SERVICE_GM_ID)
      const activeUserCount = humans.length
      const activeGmCount = humans.filter((u) => u.isGM).length
      await this._api.post(`/api/v1/installations/${this._installationId}/activity`, {
        activeUserCount,
        // Zero human GMs + a queued provision is what triggers the service-GM.
        activeGmCount,
        source: 'foundry-plugin',
        // Foundry's native world id — Core maps it to the platform world to
        // resolve a per-world idle-shutdown override.
        activeWorldId: game.world?.id ?? null,
      })
    } catch (err) {
      // Non-fatal — a missed beat just means the server reads the previous
      // value until staleness kicks in. Don't spam the console for network
      // blips; the connection banner already surfaces sustained outages.
      console.debug?.(`${LOG} heartbeat skipped:`, err?.message || err)
    }
  }
}
