/**
 * CFG Runtime Provision Drain
 *
 * Creates the Foundry User documents the platform has RESERVED for players
 * granted access while the world is live. Foundry only lets a Gamemaster create
 * User docs, and a user written to disk mid-session isn't seen until reload —
 * so the platform can't do this itself. A connected GM client does it instead:
 * this drain pulls the pending-provision queue, creates each reserved user with
 * the exact id + derived password the proxy expects, and confirms it. The proxy
 * then SSOs the invited player straight into the world.
 *
 * The same code runs whether the connected GM is a human (their browser) or the
 * headless service-GM the platform spins up when no human is present.
 *
 * Single-drainer election: the module runs in every client, so — like the
 * activity heartbeat — only one drains. The active GM with the smallest id is
 * the drainer; everyone else stays quiet. Creating with a duplicate `_id`
 * throws, so this election (plus the per-id existence check) prevents races.
 *
 * Auth: posts through the shared CoreAPIClient (installation key cfg-hosted /
 * paired key self-hosted). The endpoints are owner-scoped.
 */

'use strict'

const MODULE_ID = 'crit-fumble-core'
const LOG = 'CFG Core | Provision |'
const DRAIN_MS = 15_000 // Snappy enough for "refresh in a moment" without polling hot.

export class ProvisionDrain {
  /**
   * @param {import('../clients/api-client.js').CoreAPIClient} apiClient
   * @param {string} installationId
   */
  constructor(apiClient, installationId) {
    this._api = apiClient
    this._installationId = installationId
    this._handle = null
    this._busy = false
  }

  /** Begin draining. Call once on ready from a GM client (cfg-hosted/paired). */
  start() {
    if (!this._installationId) return
    this._tick()
    this._handle = setInterval(() => this._tick(), DRAIN_MS)
    console.log(`${LOG} drain started for installation ${this._installationId}`)
  }

  stop() {
    if (this._handle) {
      clearInterval(this._handle)
      this._handle = null
    }
  }

  /** Am I the elected drainer this tick? Smallest active GM id wins. */
  _isDrainer() {
    if (!game.user?.isGM) return false
    const gmIds = game.users.filter((u) => u.active && u.isGM).map((u) => u.id)
    if (gmIds.length === 0) return false
    gmIds.sort()
    return game.user.id === gmIds[0]
  }

  async _tick() {
    if (this._busy) return
    if (!this._isDrainer()) return
    const worldId = game.world?.id
    if (!worldId) return

    this._busy = true
    try {
      const res = await this._api.getPendingProvisions(this._installationId, worldId)
      const pending = Array.isArray(res?.data) ? res.data : []
      if (pending.length === 0) return
      console.log(`${LOG} draining ${pending.length} pending provision(s)`)
      for (const p of pending) {
        try {
          await this._provisionOne(p, worldId)
        } catch (err) {
          // One bad seat must not stall the rest — log and move on; the next
          // tick retries (confirm only fires after a successful create).
          console.warn(`${LOG} provision failed for ${p?.foundryUsername} (${p?.nativeUserId}):`, err?.message || err)
        }
      }
    } catch (err) {
      console.debug?.(`${LOG} drain skipped:`, err?.message || err)
    } finally {
      this._busy = false
    }
  }

  /**
   * Create one reserved Foundry user (idempotent) then confirm it. The doc must
   * carry the platform-chosen `_id` (keepId) and the derived password — that's
   * what lets the proxy's `/join` re-derivation authenticate this player.
   */
  async _provisionOne(p, worldId) {
    if (!p?.nativeUserId || !p?.foundryUsername) throw new Error('malformed provision')

    let user = game.users.get(p.nativeUserId)
    if (!user) {
      // Foundry enforces unique usernames. A native (manually-created) user may
      // already hold this name — disambiguate so the reserved-id doc still gets
      // created (the name is cosmetic; the id + password are what SSO needs).
      let name = p.foundryUsername
      if (game.users.some((u) => u.name === name)) {
        name = `${name} [${p.nativeUserId.slice(0, 4)}]`.slice(0, 32)
      }
      user = await User.create(
        {
          _id: p.nativeUserId,
          name,
          role: p.role,
          // Raw — Foundry hashes it server-side on create, so the proxy's /join
          // (which sends the same derived raw password) validates cleanly.
          password: p.password,
          flags: { [MODULE_ID]: { cfgRuntimeProvisioned: true, provisionedAt: Date.now() } },
        },
        { keepId: true },
      )
      if (!user) throw new Error('User.create returned null')
      console.log(`${LOG} created ${name} (${p.nativeUserId}) role=${p.role}`)
    }

    await this._api.confirmProvision(this._installationId, worldId, p.nativeUserId)
    console.log(`${LOG} confirmed ${p.foundryUsername} (${p.nativeUserId})`)
  }
}
