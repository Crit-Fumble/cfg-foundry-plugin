/**
 * CFG Party Roster Panel
 *
 * Displays the Core platform party roster (members, characters, roles) in a
 * collapsible Foundry Application panel. Works in both narrative and full mode
 * — character stat blocks are not shown (those require full integration), but
 * player names, characters, and roles are always available.
 *
 * The roster is populated from:
 *   GET /api/campaigns/{id}/parties
 *
 * GMs see all parties. Players see only parties they belong to.
 */

'use strict'

const MODULE_ID = 'crit-fumble-core'
const LOG = 'CFG Core | Party |'

// ── PartyRosterPanel ──────────────────────────────────────────────────────────

export class PartyRosterPanel extends Application {
  /** @param {import('./api-client.js').CoreAPIClient} apiClient */
  constructor(apiClient, campaignId) {
    super()
    this._api = apiClient
    this._campaignId = campaignId
    this._parties = []
    this._loading = false
    this._error = null
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: 'cfg-party-roster',
      title: 'CFG Party Roster',
      width: 280,
      height: 'auto',
      resizable: false,
      classes: ['themed', 'cfg-app', 'cfg-panel', 'cfg-party-roster'],
    })
  }

  async _renderInner() {
    if (this._loading) {
      return $(`<div class="cfg-panel-body cfg-loading">Loading party roster…</div>`)
    }
    if (this._error) {
      return $(`<div class="cfg-panel-body cfg-error">${this._error}</div>`)
    }
    if (!this._parties.length) {
      return $(`<div class="cfg-panel-body cfg-empty">No parties found for this campaign.</div>`)
    }

    const partiesHtml = this._parties
      .map((party) => {
        const members = (party.members ?? [])
          .map((m) => {
            const role = m.role === 'gm' ? '🎲 GM' : m.role === 'player' ? '🧙 ' : '👁 '
            const name = m.character?.name ?? m.user?.name ?? 'Unknown'
            return `<li class="cfg-roster-member">${role} ${name}</li>`
          })
          .join('')
        return `
        <div class="cfg-roster-party">
          <h4 class="cfg-roster-party-name">${party.name ?? 'Party'}</h4>
          <ul class="cfg-roster-members">${members || '<li class="cfg-empty">No members</li>'}</ul>
        </div>`
      })
      .join('')

    const html = `
      <div class="cfg-panel-body">
        ${partiesHtml}
        <div class="cfg-panel-footer">
          <button class="cfg-btn-small cfg-refresh-roster" title="Refresh roster">↺ Refresh</button>
        </div>
      </div>`

    const $el = $(html)
    $el.find('.cfg-refresh-roster').on('click', () => this.refresh())
    return $el
  }

  activateListeners(html) {
    super.activateListeners(html)
  }

  /** Load parties from Core and re-render. */
  async refresh() {
    this._loading = true
    this._error = null
    this.render(true)

    try {
      const data = await this._api.getParties(this._campaignId)
      this._parties = data.parties ?? data ?? []
    } catch (err) {
      console.error(`${LOG} Failed to load party roster:`, err)
      this._error = err.message
    } finally {
      this._loading = false
      this.render(true)
    }
  }
}

// ── Singleton + hooks ─────────────────────────────────────────────────────────

let _panel = null

/**
 * Open (or focus) the party roster panel.
 * @param {import('./api-client.js').CoreAPIClient} apiClient
 * @param {string} campaignId
 */
export function openPartyRoster(apiClient, campaignId) {
  if (!_panel) _panel = new PartyRosterPanel(apiClient, campaignId)
  _panel.render(true)
  if (!_panel._parties.length && !_panel._loading) _panel.refresh()
}

/** Register a scene controls button to open the panel. */
export function registerPartyRosterButton() {
  Hooks.on('getSceneControlButtons', (controls) => {
    const tokenControls = controls.find((c) => c.name === 'token')
    if (!tokenControls) return
    tokenControls.tools.push({
      name: 'cfg-party-roster',
      title: 'CFG Party Roster',
      icon: 'fas fa-users',
      button: true,
      onClick: () => {
        const cfg = window.CFGCore
        if (cfg?.api && cfg.campaignId()) openPartyRoster(cfg.api, cfg.campaignId())
      },
    })
  })
}
