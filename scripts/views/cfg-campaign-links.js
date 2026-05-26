/**
 * Linked Campaigns — GM-facing dialog to manage the N:M relationship
 * between this Foundry world and CFG campaigns.
 *
 * The plugin's `campaignId` setting binds the world to ONE campaign for
 * plugin-side sync (system reporting, etc.). The N:M link tracked here is
 * a separate concern: "which campaigns can be played in this Foundry
 * world." A campaign can be linked to multiple worlds; a world can host
 * multiple campaigns.
 *
 * Surface: Settings → Module Settings → Crit-Fumble Core → "Open Linked
 * Campaigns". Shows a checkbox per campaign the GM owns; saving the
 * dialog diffs against the server-side state and POSTs/DELETEs as needed.
 *
 * Backend:
 *   GET    /api/v1/account/foundry/campaigns
 *   POST   /api/v1/account/foundry/campaigns/:campaignId/worlds
 *   DELETE /api/v1/account/foundry/campaigns/:campaignId/worlds/:linkId
 */

const MODULE_ID = 'crit-fumble-core'

export class CfgCampaignLinksDialog extends foundry.applications.api.ApplicationV2 {
  constructor(options = {}) {
    super(options)

    if (!game.user.isGM) {
      ui.notifications.error('Only Game Masters can manage campaign links')
      throw new Error('Insufficient permissions')
    }

    /** @type {Array<Object>} */
    this.campaigns = []
    /** @type {string|null} */
    this.installationId = null
    this.loading = true
    this.errorMessage = null
  }

  static DEFAULT_OPTIONS = {
    id: 'cfg-campaign-links',
    tag: 'div',
    window: {
      title: 'Crit-Fumble — Linked Campaigns',
      icon: 'fas fa-link',
      resizable: true,
      minimizable: true,
    },
    position: { width: 560, height: 520 },
    classes: ['themed', 'cfg-app', 'cfg-campaign-links'],
  }

  _getInstallationId() {
    try {
      return game.settings.get(MODULE_ID, 'installationId') || null
    } catch {
      return null
    }
  }

  async _loadData() {
    this.loading = true
    this.errorMessage = null
    this.installationId = this._getInstallationId()

    const apiUrl = game.settings.get(MODULE_ID, 'coreApiUrl')
    try {
      const res = await fetch(`${apiUrl.replace(/\/+$/, '')}/api/v1/account/foundry/campaigns`, {
        credentials: 'include',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const payload = await res.json()
      this.campaigns = Array.isArray(payload?.data) ? payload.data : []
    } catch (err) {
      this.errorMessage = `Couldn't load campaigns: ${err?.message ?? err}`
      this.campaigns = []
    } finally {
      this.loading = false
    }
  }

  async _prepareContext(options) {
    if (!options?.parts || options.parts.includes('content')) {
      await this._loadData()
    }
    return {}
  }

  async _renderHTML() {
    const root = document.createElement('div')
    root.style.cssText = 'padding: 16px; display: flex; flex-direction: column; gap: 14px; height: 100%; overflow: auto;'

    root.appendChild(this._renderHeader())
    root.appendChild(this._renderBody())
    return root
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result)
  }

  _renderHeader() {
    const wrap = document.createElement('div')
    const title = document.createElement('p')
    title.style.cssText = 'margin: 0 0 4px 0; font-size: 13px; color: #d4c5e8;'
    title.innerHTML = `Linking a campaign here means it can be played in <strong>${game.world?.title ?? game.world?.id ?? 'this world'}</strong> on this Foundry installation. Many campaigns can share one world; one campaign can be linked to many worlds.`
    wrap.appendChild(title)

    const sub = document.createElement('p')
    sub.style.cssText = 'margin: 0; font-size: 11px; opacity: 0.6;'
    sub.textContent = `Installation: ${this.installationId ?? '— (not linked to a CFG account yet)'}`
    wrap.appendChild(sub)
    return wrap
  }

  _renderBody() {
    const wrap = document.createElement('div')
    wrap.style.cssText = 'flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 10px;'

    if (this.loading) {
      const p = document.createElement('p')
      p.textContent = 'Loading campaigns…'
      p.style.cssText = 'opacity: 0.6;'
      wrap.appendChild(p)
      return wrap
    }

    if (this.errorMessage) {
      const err = document.createElement('div')
      err.textContent = this.errorMessage
      err.style.cssText =
        'border: 1px solid rgba(239,68,68,0.4); background: rgba(127,29,29,0.25); color: #fecaca; padding: 8px 10px; border-radius: 4px; font-size: 13px;'
      wrap.appendChild(err)
      return wrap
    }

    if (!this.installationId) {
      const warn = document.createElement('div')
      warn.style.cssText =
        'border: 1px solid rgba(245,158,11,0.4); background: rgba(120,53,15,0.25); color: #fde68a; padding: 8px 10px; border-radius: 4px; font-size: 13px;'
      warn.textContent =
        'No CFG installation linked to this Foundry world yet. Link your account in Module Settings → Crit-Fumble Link first.'
      wrap.appendChild(warn)
      return wrap
    }

    if (this.campaigns.length === 0) {
      const empty = document.createElement('p')
      empty.style.cssText = 'opacity: 0.6;'
      empty.textContent =
        "You don't own any campaigns yet. Create one at Crit-Fumble first, then return here to link it."
      wrap.appendChild(empty)
      return wrap
    }

    const list = document.createElement('div')
    list.style.cssText = 'flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 4px;'
    const currentWorldId = game.world?.id ?? null
    for (const c of this.campaigns) {
      list.appendChild(this._renderCampaignRow(c, currentWorldId))
    }
    wrap.appendChild(list)

    const actions = document.createElement('div')
    actions.style.cssText = 'display: flex; justify-content: flex-end; gap: 8px; padding-top: 4px; border-top: 1px solid rgba(255,255,255,0.08);'
    const saveBtn = document.createElement('button')
    saveBtn.type = 'button'
    saveBtn.textContent = 'Save Changes'
    saveBtn.style.cssText =
      'font-size: 13px; padding: 6px 14px; border-radius: 4px; border: 1px solid rgba(163,132,224,0.6); background: rgba(124,58,237,0.4); color: #f0e6ff; cursor: pointer;'
    saveBtn.addEventListener('click', () => this._handleSave(saveBtn))
    actions.appendChild(saveBtn)
    wrap.appendChild(actions)

    return wrap
  }

  _renderCampaignRow(campaign, currentWorldId) {
    const row = document.createElement('label')
    row.style.cssText =
      'display: flex; align-items: flex-start; gap: 10px; padding: 8px 10px; border: 1px solid rgba(255,255,255,0.08); border-radius: 4px; background: rgba(255,255,255,0.02); cursor: pointer;'

    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.dataset.campaignId = campaign.id
    checkbox.style.marginTop = '3px'

    // Find an existing link to this (install, world) pair
    const link = (campaign.linkedWorlds ?? []).find(
      (l) => l.installationId === this.installationId && l.worldId === currentWorldId,
    )
    checkbox.checked = !!link
    if (link) checkbox.dataset.linkId = link.id
    // Track the initial state so we only POST/DELETE on diffs.
    checkbox.dataset.initialChecked = link ? 'true' : 'false'
    row.appendChild(checkbox)

    const text = document.createElement('div')
    text.style.cssText = 'flex: 1; min-width: 0;'

    const name = document.createElement('div')
    name.textContent = campaign.name ?? campaign.slug ?? campaign.id
    name.style.cssText = 'font-size: 14px; color: #f0e6ff;'
    text.appendChild(name)

    const meta = document.createElement('div')
    meta.style.cssText = 'font-size: 11px; opacity: 0.6; font-family: ui-monospace, monospace;'
    const systemTag = campaign.platformSystemName ?? campaign.platformSystemSlug ?? null
    const otherLinks = (campaign.linkedWorlds ?? []).filter(
      (l) => !(l.installationId === this.installationId && l.worldId === currentWorldId),
    )
    const otherSummary = otherLinks.length
      ? ` • also linked to ${otherLinks.length} other world${otherLinks.length === 1 ? '' : 's'}`
      : ''
    meta.textContent = `${systemTag ?? 'no system'}${otherSummary}`
    text.appendChild(meta)

    row.appendChild(text)
    return row
  }

  async _handleSave(button) {
    const root = this.element
    if (!root) return
    const boxes = Array.from(root.querySelectorAll('input[type=checkbox][data-campaign-id]'))
    const toAdd = []
    const toRemove = []
    for (const b of boxes) {
      const initial = b.dataset.initialChecked === 'true'
      const now = b.checked
      if (initial === now) continue
      if (now) toAdd.push({ campaignId: b.dataset.campaignId })
      else toRemove.push({ campaignId: b.dataset.campaignId, linkId: b.dataset.linkId })
    }

    if (!toAdd.length && !toRemove.length) {
      ui.notifications.info('No changes to save.')
      return
    }

    button.disabled = true
    button.style.opacity = '0.6'
    const apiUrl = game.settings.get(MODULE_ID, 'coreApiUrl').replace(/\/+$/, '')
    const worldId = game.world?.id
    try {
      // Run additions + removals in parallel; report aggregated success/failure.
      const results = await Promise.allSettled([
        ...toAdd.map((a) =>
          fetch(`${apiUrl}/api/v1/account/foundry/campaigns/${encodeURIComponent(a.campaignId)}/worlds`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ installationId: this.installationId, worldId }),
          }),
        ),
        ...toRemove
          .filter((r) => r.linkId)
          .map((r) =>
            fetch(
              `${apiUrl}/api/v1/account/foundry/campaigns/${encodeURIComponent(r.campaignId)}/worlds/${encodeURIComponent(r.linkId)}`,
              { method: 'DELETE', credentials: 'include' },
            ),
          ),
      ])
      const failed = results.filter((r) => r.status === 'rejected' || !r.value.ok)
      if (failed.length) {
        ui.notifications.warn(`${failed.length} of ${results.length} updates failed; some links may not have saved.`)
      } else {
        ui.notifications.info(`Updated ${results.length} link${results.length === 1 ? '' : 's'}.`)
      }
      await this.render({ parts: ['content'] })
    } catch (err) {
      ui.notifications.error(`Save failed: ${err?.message ?? err}`)
    } finally {
      button.disabled = false
      button.style.opacity = '1'
    }
  }
}
