/**
 * CFG Link Settings — module-settings menu surface for the pair flow (#698).
 *
 * Foundry exposes module settings as a flat list of label/control rows. To
 * host an action button + a multi-line status row in that flat list we
 * register a `settings.registerMenu` entry that opens this ApplicationV2.
 *
 * Single source of truth for link state lives in `pair-flow.js`; this view
 * just reads + subscribes.
 */

'use strict'

import {
  startPairFlow,
  cancelPairFlow,
  unlinkPair,
  getPairState,
  onPairStateChange,
  isLinked,
  getCfgEndpoint,
} from '../auth/pair-flow.js'
import { getHostKind } from '../auth/host-context.js'

const MODULE_ID = 'crit-fumble-core'

export class CfgLinkSettings extends foundry.applications.api.ApplicationV2 {
  constructor(options = {}) {
    super(options)
    this._unsubscribe = null
    this._linkedUser = null // populated by _refreshLinkedUser
  }

  static DEFAULT_OPTIONS = {
    id: 'cfg-link-settings',
    tag: 'div',
    window: {
      title: 'Crit-Fumble Link',
      icon: 'fa-solid fa-link',
      resizable: false,
    },
    position: {
      width: 480,
      height: 'auto',
    },
    classes: ['themed', 'cfg-app', 'cfg-link-settings'],
  }

  /* -------------------------------------------- */
  /*  Lifecycle                                    */
  /* -------------------------------------------- */

  async _renderHTML() {
    const root = document.createElement('div')
    root.className = 'cfg-link-root'
    root.style.cssText = 'padding: 1rem; display: flex; flex-direction: column; gap: 1rem; font-size: 0.95rem;'

    root.appendChild(this._renderStatusRow())
    root.appendChild(this._renderActionRow())
    root.appendChild(this._renderHelpText())

    return root
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result)
  }

  async _onRender(_context, _options) {
    this._unsubscribe = onPairStateChange(() => this._refresh())
    await this._refreshLinkedUser()
    this._refresh()
  }

  async close(options = {}) {
    if (this._unsubscribe) {
      this._unsubscribe()
      this._unsubscribe = null
    }
    // Don't auto-cancel a pending pair on close — the user may have closed
    // this window to keep working in Foundry while waiting for the browser
    // tab. The flow's own 5-min expiry timer is the safety net.
    return super.close(options)
  }

  /* -------------------------------------------- */
  /*  DOM construction                             */
  /* -------------------------------------------- */

  _renderStatusRow() {
    const row = document.createElement('div')
    row.className = 'cfg-link-status'
    row.style.cssText =
      'padding: 0.75rem; border: 1px solid var(--color-border-light-tertiary, #888); border-radius: 4px; background: var(--color-bg-option, rgba(0,0,0,0.05));'

    const label = document.createElement('div')
    label.style.cssText = 'font-weight: 600; margin-bottom: 0.25rem;'
    label.textContent = 'Connection'
    row.appendChild(label)

    const value = document.createElement('div')
    value.className = 'cfg-link-status-value'
    value.dataset.role = 'status-value'
    value.style.cssText = 'font-family: var(--font-mono, monospace); word-break: break-all;'
    row.appendChild(value)

    const code = document.createElement('div')
    code.className = 'cfg-link-pair-code'
    code.dataset.role = 'pair-code'
    code.style.cssText =
      'margin-top: 0.5rem; font-family: var(--font-mono, monospace); font-size: 1.15rem; display: none;'
    row.appendChild(code)

    return row
  }

  _renderActionRow() {
    const row = document.createElement('div')
    row.className = 'cfg-link-actions'
    row.style.cssText = 'display: flex; gap: 0.5rem;'

    const link = document.createElement('button')
    link.type = 'button'
    link.dataset.role = 'link-btn'
    link.className = 'cfg-link-btn'
    link.textContent = 'Link to Crit-Fumble'
    link.addEventListener('click', () => this._onLinkClick())
    row.appendChild(link)

    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.dataset.role = 'cancel-btn'
    cancel.className = 'cfg-link-cancel-btn'
    cancel.textContent = 'Cancel'
    cancel.style.display = 'none'
    cancel.addEventListener('click', () => this._onCancelClick())
    row.appendChild(cancel)

    const unlink = document.createElement('button')
    unlink.type = 'button'
    unlink.dataset.role = 'unlink-btn'
    unlink.className = 'cfg-link-unlink-btn'
    unlink.textContent = 'Unlink'
    unlink.style.display = 'none'
    unlink.addEventListener('click', () => this._onUnlinkClick())
    row.appendChild(unlink)

    return row
  }

  _renderHelpText() {
    const help = document.createElement('div')
    help.className = 'cfg-link-help'
    help.style.cssText = 'font-size: 0.85rem; opacity: 0.75;'
    help.innerHTML = `
      <p style="margin: 0 0 0.5rem;">Link this Foundry world to your Crit-Fumble account.
      A one-time code will open in your browser; confirm the link there to issue an API key
      that this world can use to talk to Crit-Fumble.</p>
      <p style="margin: 0;">Self-hosters: change the <em>CFG Endpoint</em> setting if you run your own
      Crit-Fumble platform instance. The endpoint defaults to
      <code>https://core.crit-fumble.com</code>.</p>
    `
    return help
  }

  /* -------------------------------------------- */
  /*  Refresh                                      */
  /* -------------------------------------------- */

  async _refreshLinkedUser() {
    // CFG-hosted Foundry shows a fixed status row — no need to fetch the
    // user identity, and the bundled apiKey may not represent a single user.
    if (getHostKind() === 'cfg-hosted') {
      this._linkedUser = null
      return
    }
    if (!isLinked()) {
      this._linkedUser = null
      return
    }
    // Best-effort: fetch the linked user's display name. fetchCfg never
    // throws — offline/auth-failed/etc. simply leave the linked-user label
    // empty and the row falls back to the endpoint string.
    const { fetchCfg } = await import('../auth/pair-flow.js')
    const res = await fetchCfg('/api/v1/account/user')
    if (res.ok) {
      const name = res.data?.user?.name || res.data?.user?.email || null
      this._linkedUser = name ? String(name) : null
    } else {
      this._linkedUser = null
    }
  }

  _refresh() {
    const el = this.element
    if (!el) return

    const state = getPairState()
    const linked = isLinked()
    const endpoint = getCfgEndpoint()
    const hostKind = getHostKind()
    const isHosted = hostKind === 'cfg-hosted'

    const statusValue = el.querySelector('[data-role="status-value"]')
    const codeEl = el.querySelector('[data-role="pair-code"]')
    const linkBtn = el.querySelector('[data-role="link-btn"]')
    const cancelBtn = el.querySelector('[data-role="cancel-btn"]')
    const unlinkBtn = el.querySelector('[data-role="unlink-btn"]')

    if (statusValue) {
      statusValue.textContent = this._formatStatus(state, linked, endpoint, hostKind)
    }
    if (codeEl) {
      if (!isHosted && state.status === 'pending' && state.code) {
        codeEl.style.display = 'block'
        codeEl.textContent = `Pairing code: ${state.code}`
      } else {
        codeEl.style.display = 'none'
        codeEl.textContent = ''
      }
    }

    const pending = state.status === 'pending'
    if (linkBtn) {
      // CFG-hosted: the proxy already wrote our key; pairing is meaningless.
      // Self-hosted: show the button when not linked + not mid-flow.
      linkBtn.style.display = isHosted || linked || pending ? 'none' : 'inline-block'
      linkBtn.disabled = pending
    }
    if (cancelBtn) {
      cancelBtn.style.display = !isHosted && pending ? 'inline-block' : 'none'
    }
    if (unlinkBtn) {
      // CFG-hosted users can't unlink — the key belongs to the container, not
      // the world's settings. Hide rather than disable: a tooltip wouldn't
      // explain it any better than "not shown".
      unlinkBtn.style.display = !isHosted && linked && !pending ? 'inline-block' : 'none'
    }

    // Refresh user label after a successful pair so the next refresh shows
    // the linked identity instead of just the endpoint.
    if (!isHosted && state.status === 'completed') {
      void this._refreshLinkedUser().then(() => this._refresh())
    }
  }

  _formatStatus(state, linked, endpoint, hostKind) {
    if (hostKind === 'cfg-hosted') {
      return 'Linked via CFG-hosted Foundry container'
    }
    if (state.status === 'pending') {
      return `Waiting for browser confirmation… (code valid for 5 min)`
    }
    if (state.status === 'expired') {
      return 'Pairing expired — try again.'
    }
    if (state.status === 'error') {
      return `Error: ${state.error || 'unknown'}`
    }
    if (linked) {
      const who = this._linkedUser ? this._linkedUser : 'this account'
      return `Linked: ${who} @ ${endpoint}`
    }
    return 'Not linked'
  }

  /* -------------------------------------------- */
  /*  Actions                                      */
  /* -------------------------------------------- */

  async _onLinkClick() {
    // Defence-in-depth: the button is hidden for CFG-hosted, but the click
    // handler is still wired. Bail rather than start a doomed pair flow.
    if (getHostKind() === 'cfg-hosted') return
    try {
      await startPairFlow()
    } catch (err) {
      ui.notifications?.error?.(`CFG link failed: ${err?.message || err}`)
    }
  }

  _onCancelClick() {
    cancelPairFlow()
  }

  async _onUnlinkClick() {
    if (getHostKind() === 'cfg-hosted') return
    const confirmed = await Dialog.confirm({
      title: 'Unlink from Crit-Fumble',
      content: '<p>This will remove the stored API key from this world. Continue?</p>',
      defaultYes: false,
    })
    if (!confirmed) return
    await unlinkPair()
    this._linkedUser = null
    this._refresh()
    ui.notifications?.info?.('CFG: unlinked.')
  }
}

/**
 * Register the settings menu so it appears in Configure Settings →
 * Crit-Fumble Core. Idempotent — duplicate registers are no-ops in Foundry.
 */
export function registerCfgLinkMenu() {
  game.settings.registerMenu(MODULE_ID, 'cfgLinkMenu', {
    name: 'Crit-Fumble Link',
    label: 'Open Link Settings',
    hint: 'Link this Foundry world to a Crit-Fumble account using a one-time browser code.',
    icon: 'fas fa-link',
    type: CfgLinkSettings,
    restricted: true, // GM only — the API key is world-scoped.
  })
}
