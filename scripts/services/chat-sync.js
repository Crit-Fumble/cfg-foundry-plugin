/**
 * ChatSyncManager — Foundry ↔ Core platform chat unification.
 *
 * Behaviour:
 *   - Forwards every new Foundry ChatMessage to Core via POST /api/v1/player/campaigns/{id}/chat/foundry
 *   - Polls GET /api/campaigns/{id}/chat?since={iso} for messages sent from Core
 *   - Tags injected messages with a `coreMessageId` flag to suppress echo loops
 *   - GM client owns the polling loop; players receive injected messages via Foundry's
 *     built-in socket replication so only one request hits Core per message.
 */

const MODULE_ID = 'crit-fumble-core'
const LOG = 'CFG Core | Chat |'
const FLAG_SCOPE = MODULE_ID
const FLAG_KEY = 'coreMessageId'
const POLL_MS = 5_000

export class ChatSyncManager {
  /**
   * @param {import('../clients/api-client.js').CoreAPIClient} api
   * @param {string} campaignId
   */
  constructor(api, campaignId) {
    this._api = api
    this._campaignId = campaignId
    this._since = new Date().toISOString()
    this._pollTimer = null
    this._sending = false
    this._hookId = null
  }

  /* -------------------------------------------- */
  /*  Lifecycle                                    */
  /* -------------------------------------------- */

  start() {
    // Forward Foundry → Core
    this._hookId = Hooks.on('createChatMessage', (msg) => this._onFoundryMessage(msg))

    // Poll Core → Foundry (GM only — Foundry socket replicates to players)
    if (game.user.isGM) {
      this._pollTimer = setInterval(() => this._pollCore(), POLL_MS)
    }

    console.log(`${LOG} Started (campaign: ${this._campaignId})`)
  }

  stop() {
    if (this._hookId !== null) {
      Hooks.off('createChatMessage', this._hookId)
      this._hookId = null
    }
    if (this._pollTimer !== null) {
      clearInterval(this._pollTimer)
      this._pollTimer = null
    }
    console.log(`${LOG} Stopped`)
  }

  /* -------------------------------------------- */
  /*  Foundry → Core                              */
  /* -------------------------------------------- */

  async _onFoundryMessage(msg) {
    // Skip messages that originated from Core (flag set on injection)
    if (msg.getFlag(FLAG_SCOPE, FLAG_KEY)) return

    // Skip whisper-only messages to avoid noise
    if (msg.whisper?.length) return

    if (this._sending) return // debounce rapid bursts
    this._sending = true

    try {
      /** @type {Record<string, unknown>} */
      const payload = {
        content: msg.content ?? '',
        speakerName: msg.alias || msg.speaker?.alias || game.user.name,
        foundryUserId: msg.speaker?.actor ?? game.user.id,
        timestamp: msg.timestamp ? new Date(msg.timestamp).toISOString() : new Date().toISOString(),
      }

      // Include roll data when present so Core can persist to the session roll log
      if (msg.isRoll && msg.rolls?.length) {
        const primaryRoll = msg.rolls[0]
        payload.isRoll = true
        payload.rollData = {
          formula: primaryRoll.formula,
          total: primaryRoll.total,
          // Extract individual die results from Foundry v12 Roll structure
          rolls: primaryRoll.dice?.flatMap((d) => d.results?.map((r) => r.result) ?? []) ?? [],
          label: msg.flavor || null,
        }
      }

      await this._api.post(`/api/v1/player/campaigns/${this._campaignId}/chat/foundry`, payload)
    } catch (err) {
      console.warn(`${LOG} Failed to forward message to Core:`, err.message)
    } finally {
      this._sending = false
    }
  }

  /* -------------------------------------------- */
  /*  Core → Foundry                              */
  /* -------------------------------------------- */

  async _pollCore() {
    try {
      const data = await this._api.get(
        `/api/campaigns/${this._campaignId}/chat?since=${encodeURIComponent(this._since)}`,
      )

      const messages = data?.messages ?? []
      if (!messages.length) return

      // Advance cursor so next poll doesn't re-fetch these
      this._since = new Date().toISOString()

      for (const msg of messages) {
        await this._injectFromCore(msg)
      }
    } catch (err) {
      console.warn(`${LOG} Poll failed:`, err.message)
    }
  }

  /**
   * Inject a Core message into Foundry chat without triggering the outbound hook.
   * @param {{ id: string, content: string, speakerName: string, timestamp: string }} msg
   */
  async _injectFromCore(msg) {
    try {
      await ChatMessage.create({
        content: foundry.utils.escapeHTML(msg.content),
        speaker: { alias: msg.speakerName ?? 'Core' },
        flags: { [FLAG_SCOPE]: { [FLAG_KEY]: msg.id } },
      })
    } catch (err) {
      console.warn(`${LOG} Failed to inject Core message:`, err.message)
    }
  }
}
