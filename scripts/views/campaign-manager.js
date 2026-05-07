/**
 * Campaign Manager (ApplicationV2)
 * Manages linked campaigns, player rosters, and content assignment
 */

import { CampaignFlags } from '../utils/campaign-flags.js'
import { useCampaigns } from '../hooks/useCampaigns.js'
import { useParties } from '../hooks/useParties.js'
/* ---- Officer position presets (inlined; officer-positions.js removed in Phase 1 slim-down) ---- */

const POSITION_PRESETS = {
  default: {
    name: 'Standard',
    description: 'Leader + Member roles',
    positions: [
      { id: 'leader', name: 'Leader', icon: 'fas fa-crown', required: true, unique: true, order: 0 },
      { id: 'member', name: 'Member', icon: 'fas fa-user', required: false, unique: false, order: 1 },
    ],
  },
}

function getCampaignPositions(campaignId) {
  const all = game.settings.get(MODULE_ID, 'campaignPositions') || {}
  const config = all[campaignId] || {}
  const preset = POSITION_PRESETS[config.preset] ?? POSITION_PRESETS.default
  return {
    requireLeader: config.requireLeader ?? false,
    positions: preset.positions,
    preset: config.preset ?? 'default',
  }
}

async function setCampaignPositions(campaignId, config) {
  const all = game.settings.get(MODULE_ID, 'campaignPositions') || {}
  all[campaignId] = { ...all[campaignId], ...config }
  await game.settings.set(MODULE_ID, 'campaignPositions', all)
}

function getSortedPositions(positions = []) {
  return [...positions].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}
import { setElementContent, createButton, formatTimeAgo } from '../utils/dom-helpers.js'

const MODULE_ID = 'crit-fumble-core'

export class CampaignManager extends foundry.applications.api.ApplicationV2 {
  constructor(options = {}) {
    super(options)

    // Restrict to GM only
    if (!game.user.isGM) {
      ui.notifications.error('Only Game Masters can manage campaigns')
      throw new Error('Insufficient permissions')
    }

    // State
    this.campaignsHook = new useCampaigns()
    this.partiesHook = null
    this.selectedCampaignId = null
    this.loading = false

    // Load initial data
    this._loadData()
  }

  static DEFAULT_OPTIONS = {
    id: 'cfg-campaign-manager',
    window: {
      title: 'Campaign Manager',
      icon: 'fa-solid fa-users',
      resizable: true,
      maximizable: true,
      minimizable: true,
    },
    position: {
      width: 1000,
      height: 700,
    },
    actions: {
      linkCampaign: CampaignManager._onLinkCampaign,
      unlinkCampaign: CampaignManager._onUnlinkCampaign,
      setActiveCampaign: CampaignManager._onSetActiveCampaign,
      clearFilter: CampaignManager._onClearFilter,
      selectCampaign: CampaignManager._onSelectCampaign,
      syncCampaign: CampaignManager._onSyncCampaign,
      syncAll: CampaignManager._onSyncAll,
      assignContent: CampaignManager._onAssignContent,
      openContentAssignment: CampaignManager._onOpenContentAssignment,
      saveTerminology: CampaignManager._onSaveTerminology,
      savePositionConfig: CampaignManager._onSavePositionConfig,
    },
    classes: ['themed', 'cfg-app'],
  }

  /* -------------------------------------------- */
  /*  Data Loading                                */
  /* -------------------------------------------- */

  async _loadData() {
    this.loading = true
    await this.campaignsHook.load()

    // Auto-select first campaign if none selected
    if (!this.selectedCampaignId && this.campaignsHook.linkedCampaigns.length > 0) {
      this.selectedCampaignId = this.campaignsHook.linkedCampaigns[0].campaignId
    }

    // Load parties for selected campaign
    if (this.selectedCampaignId) {
      this.partiesHook = new useParties(this.selectedCampaignId)
      await this.partiesHook.load()
    }

    this.loading = false
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  async _renderHTML(context, options) {
    const container = document.createElement('div')
    container.className = 'cfg-campaign-manager'

    // Header
    container.appendChild(this._buildHeader())

    // Main content (split panel)
    const content = document.createElement('div')
    content.className = 'cfg-manager-content'

    // Left panel - campaign list
    content.appendChild(this._buildCampaignList())

    // Right panel - campaign details
    content.appendChild(this._buildCampaignDetails())

    container.appendChild(content)

    return container
  }

  _buildHeader() {
    const header = document.createElement('div')
    header.className = 'cfg-header'

    // Title
    const title = document.createElement('h2')
    setElementContent(title, 'Campaign Manager', { icon: 'fas fa-users' })
    header.appendChild(title)

    // Buttons
    const buttons = document.createElement('div')
    buttons.className = 'cfg-header-buttons'

    // Link Campaign button
    const linkBtn = createButton('Link Campaign', {
      icon: 'fas fa-link',
      className: 'cfg-button cfg-button--primary',
      attributes: { 'data-action': 'linkCampaign' },
    })
    buttons.appendChild(linkBtn)

    // Sync All button
    const syncAllBtn = createButton('Sync All', {
      icon: 'fas fa-sync',
      className: 'cfg-button cfg-button--secondary',
      attributes: { 'data-action': 'syncAll' },
    })
    buttons.appendChild(syncAllBtn)

    // Filter mode indicator
    const filterMode = this.campaignsHook.filterMode
    const filterIndicator = document.createElement('div')
    filterIndicator.className = 'cfg-filter-mode'

    const filterLabel = document.createElement('span')
    filterLabel.textContent = 'Filter: '
    filterIndicator.appendChild(filterLabel)

    const filterSelect = document.createElement('select')
    filterSelect.className = 'cfg-select'

    const optAll = document.createElement('option')
    optAll.value = 'all'
    optAll.textContent = 'Show All'
    optAll.selected = filterMode === 'all'
    filterSelect.appendChild(optAll)

    const optCampaign = document.createElement('option')
    optCampaign.value = 'campaign'
    optCampaign.textContent = 'By Campaign'
    optCampaign.selected = filterMode === 'campaign'
    filterSelect.appendChild(optCampaign)

    const optParty = document.createElement('option')
    optParty.value = 'party'
    optParty.textContent = 'By Party'
    optParty.selected = filterMode === 'party'
    filterSelect.appendChild(optParty)
    filterSelect.addEventListener('change', async (e) => {
      await this.campaignsHook.setFilterMode(e.target.value)
      ui.sidebar.render()
      ui.notifications.info(`Filter mode: ${e.target.value}`)
    })
    filterIndicator.appendChild(filterSelect)

    buttons.appendChild(filterIndicator)
    header.appendChild(buttons)

    return header
  }

  _buildCampaignList() {
    const panel = document.createElement('div')
    panel.className = 'cfg-panel cfg-panel-list'

    const heading = document.createElement('h3')
    heading.textContent = 'Linked Campaigns'
    panel.appendChild(heading)

    const linkedCampaigns = this.campaignsHook.linkedCampaigns

    if (linkedCampaigns.length === 0) {
      panel.appendChild(
        this._buildEmptyState(
          'fa-link',
          'No campaigns linked',
          'Click "Link Campaign" to connect this world to a campaign',
        ),
      )
    } else {
      const list = document.createElement('div')
      list.className = 'cfg-campaign-list'

      for (const linked of linkedCampaigns) {
        list.appendChild(this._buildCampaignItem(linked))
      }

      panel.appendChild(list)
    }

    return panel
  }

  _buildCampaignItem(linked) {
    const isActive = this.campaignsHook.isActive(linked.campaignId)
    const isSelected = linked.campaignId === this.selectedCampaignId
    const campaign = this.campaignsHook.getCampaign(linked.campaignId)

    const item = document.createElement('div')
    item.className = `cfg-list-item ${isSelected ? 'selected' : ''} ${isActive ? 'active' : ''}`
    item.dataset.campaignId = linked.campaignId

    // Click to select
    item.addEventListener('click', (e) => {
      if (!e.target.closest('button')) {
        this.selectedCampaignId = linked.campaignId
        // Reload parties for new selection
        this.partiesHook = new useParties(linked.campaignId)
        this.partiesHook.load().then(() => this.render())
      }
    })

    // Info section
    const info = document.createElement('div')
    info.className = 'cfg-list-item-info'

    const nameRow = document.createElement('div')
    nameRow.className = 'cfg-list-item-name'
    setElementContent(nameRow, linked.name, { icon: 'fas fa-dice-d20' })

    if (isActive) {
      const activeBadge = document.createElement('span')
      activeBadge.className = 'cfg-badge cfg-badge--success'
      activeBadge.textContent = 'Active'
      nameRow.appendChild(activeBadge)
    }

    info.appendChild(nameRow)

    const meta = document.createElement('div')
    meta.className = 'cfg-list-item-meta'

    const systemInfo = document.createElement('span')
    systemInfo.textContent = campaign?.system?.name || game.system.title || 'Unknown System'
    meta.appendChild(systemInfo)

    if (linked.syncedAt) {
      const syncTime = document.createElement('span')
      syncTime.className = 'cfg-sync-time'
      syncTime.title = new Date(linked.syncedAt).toLocaleString()
      setElementContent(syncTime, formatTimeAgo(linked.syncedAt), { icon: 'fas fa-clock' })
      meta.appendChild(syncTime)
    }

    info.appendChild(meta)
    item.appendChild(info)

    // Actions
    const actions = document.createElement('div')
    actions.className = 'cfg-list-item-actions'

    if (!isActive) {
      const setActiveBtn = document.createElement('button')
      setActiveBtn.type = 'button'
      setActiveBtn.className = 'cfg-button cfg-button--small'
      setActiveBtn.dataset.action = 'setActiveCampaign'
      setActiveBtn.dataset.campaignId = linked.campaignId
      setActiveBtn.title = 'Set as active filter'
      setElementContent(setActiveBtn, '', { icon: 'fas fa-check' })
      actions.appendChild(setActiveBtn)
    } else {
      const clearBtn = document.createElement('button')
      clearBtn.type = 'button'
      clearBtn.className = 'cfg-button cfg-button--small cfg-button--muted'
      clearBtn.dataset.action = 'clearFilter'
      clearBtn.title = 'Clear active filter'
      setElementContent(clearBtn, '', { icon: 'fas fa-times' })
      actions.appendChild(clearBtn)
    }

    const unlinkBtn = createButton('', {
      icon: 'fas fa-unlink',
      className: 'cfg-button cfg-button--small cfg-button--danger',
      attributes: {
        'data-action': 'unlinkCampaign',
        'data-campaign-id': linked.campaignId,
        title: 'Unlink campaign',
      },
    })
    actions.appendChild(unlinkBtn)

    item.appendChild(actions)

    return item
  }

  _buildCampaignDetails() {
    const panel = document.createElement('div')
    panel.className = 'cfg-panel cfg-panel-details'

    if (!this.selectedCampaignId) {
      panel.appendChild(
        this._buildEmptyState('fa-mouse-pointer', 'Select a campaign', 'Click on a campaign to view details'),
      )
      return panel
    }

    const linked = this.campaignsHook.getLinked(this.selectedCampaignId)
    const campaign = this.campaignsHook.getCampaign(this.selectedCampaignId)

    if (!linked) {
      panel.appendChild(
        this._buildEmptyState(
          'fa-exclamation-triangle',
          'Campaign not found',
          'The selected campaign may have been unlinked',
        ),
      )
      return panel
    }

    // Campaign header
    const header = document.createElement('div')
    header.className = 'cfg-details-header'

    const title = document.createElement('h3')
    setElementContent(title, linked.name, { icon: 'fas fa-dice-d20' })
    header.appendChild(title)

    const headerActions = document.createElement('div')
    headerActions.className = 'cfg-details-actions'

    const syncBtn = createButton('Sync', {
      icon: 'fas fa-sync',
      className: 'cfg-button cfg-button--secondary',
      attributes: {
        'data-action': 'syncCampaign',
        'data-campaign-id': linked.campaignId,
      },
    })
    headerActions.appendChild(syncBtn)

    const assignBtn = createButton('Assign Content', {
      icon: 'fas fa-folder-plus',
      className: 'cfg-button cfg-button--primary',
      attributes: {
        'data-action': 'openContentAssignment',
        'data-campaign-id': linked.campaignId,
      },
    })
    headerActions.appendChild(assignBtn)

    header.appendChild(headerActions)
    panel.appendChild(header)

    // Campaign info
    const info = document.createElement('div')
    info.className = 'cfg-details-info'

    const systemRow = document.createElement('div')
    systemRow.className = 'cfg-info-row'
    const systemLabel = document.createElement('span')
    systemLabel.className = 'cfg-info-label'
    systemLabel.textContent = 'System:'
    const systemValue = document.createElement('span')
    systemValue.className = 'cfg-info-value'
    systemValue.textContent = campaign?.system?.name || game.system.title
    systemRow.appendChild(systemLabel)
    systemRow.appendChild(systemValue)
    info.appendChild(systemRow)

    const linkedRow = document.createElement('div')
    linkedRow.className = 'cfg-info-row'
    const linkedLabel = document.createElement('span')
    linkedLabel.className = 'cfg-info-label'
    linkedLabel.textContent = 'Linked:'
    const linkedValue = document.createElement('span')
    linkedValue.className = 'cfg-info-value'
    linkedValue.textContent = new Date(linked.linkedAt).toLocaleDateString()
    linkedRow.appendChild(linkedLabel)
    linkedRow.appendChild(linkedValue)
    info.appendChild(linkedRow)

    const syncRow = document.createElement('div')
    syncRow.className = 'cfg-info-row'
    const syncLabel = document.createElement('span')
    syncLabel.className = 'cfg-info-label'
    syncLabel.textContent = 'Last Sync:'
    const syncValue = document.createElement('span')
    syncValue.className = 'cfg-info-value'
    syncValue.textContent = linked.syncedAt ? this._formatTimeAgo(linked.syncedAt) : 'Never'
    syncRow.appendChild(syncLabel)
    syncRow.appendChild(syncValue)
    info.appendChild(syncRow)

    panel.appendChild(info)

    // Terminology section (for party/member naming)
    panel.appendChild(this._buildTerminologySection(linked.campaignId))

    // Position configuration section (for officer roles)
    panel.appendChild(this._buildPositionConfigSection(linked.campaignId))

    // Parties section
    panel.appendChild(this._buildPartiesSection())

    // Player roster section
    panel.appendChild(this._buildRosterSection(campaign))

    // Content stats section
    panel.appendChild(this._buildContentStats())

    return panel
  }

  _buildTerminologySection(campaignId) {
    const section = document.createElement('div')
    section.className = 'cfg-section cfg-terminology-section'

    const heading = document.createElement('h4')
    setElementContent(heading, 'Campaign Terminology', { icon: 'fas fa-language' })
    section.appendChild(heading)

    const description = document.createElement('p')
    description.className = 'cfg-section-description'
    description.textContent = 'Customize how parties and members are named in this campaign.'
    section.appendChild(description)

    // Get current terminology
    const terminology = window.CritFumbleCore?.getCampaignTerminology?.(campaignId) || {
      partyTerm: 'Party',
      partyTermPlural: 'Parties',
      memberTerm: 'Player',
      memberTermPlural: 'Players',
      leaderTerm: 'Leader',
      unaffiliatedTerm: 'Unaffiliated',
    }

    const form = document.createElement('div')
    form.className = 'cfg-terminology-form'
    form.dataset.campaignId = campaignId

    const grid = document.createElement('div')
    grid.className = 'cfg-terminology-grid'

    // Helper to create form groups
    const createFormGroup = (id, labelText, value, placeholder) => {
      const group = document.createElement('div')
      group.className = 'cfg-form-group'
      const label = document.createElement('label')
      label.htmlFor = id
      label.textContent = labelText
      const input = document.createElement('input')
      input.type = 'text'
      input.id = id
      input.name = id
      input.value = value
      input.placeholder = placeholder
      group.appendChild(label)
      group.appendChild(input)
      return group
    }

    grid.appendChild(createFormGroup('partyTerm', 'Party (singular)', terminology.partyTerm, 'Party, Crew, Squad'))
    grid.appendChild(
      createFormGroup('partyTermPlural', 'Party (plural)', terminology.partyTermPlural, 'Parties, Crews, Squads'),
    )
    grid.appendChild(
      createFormGroup('memberTerm', 'Member (singular)', terminology.memberTerm, 'Player, Crewmate, Agent'),
    )
    grid.appendChild(
      createFormGroup(
        'memberTermPlural',
        'Member (plural)',
        terminology.memberTermPlural,
        'Players, Crewmates, Agents',
      ),
    )
    grid.appendChild(createFormGroup('leaderTerm', 'Leader', terminology.leaderTerm, 'Leader, Captain, Handler'))
    grid.appendChild(
      createFormGroup(
        'unaffiliatedTerm',
        'Unaffiliated',
        terminology.unaffiliatedTerm,
        'Unaffiliated, Privateer, Ronin',
      ),
    )

    form.appendChild(grid)

    const actions = document.createElement('div')
    actions.className = 'cfg-terminology-actions'

    const saveBtn = createButton('Save Terminology', {
      icon: 'fas fa-save',
      className: 'cfg-button cfg-button--primary',
      attributes: {
        'data-action': 'saveTerminology',
        'data-campaign-id': campaignId,
      },
    })
    actions.appendChild(saveBtn)
    form.appendChild(actions)

    section.appendChild(form)

    return section
  }

  _buildPositionConfigSection(campaignId) {
    const section = document.createElement('div')
    section.className = 'cfg-section cfg-position-config-section'

    const heading = document.createElement('h4')
    setElementContent(heading, 'Officer Positions', { icon: 'fas fa-user-shield' })
    section.appendChild(heading)

    const description = document.createElement('p')
    description.className = 'cfg-section-description'
    description.textContent =
      'Configure officer positions for crew-based campaigns (like Pirates of the Feywater Mists).'
    section.appendChild(description)

    // Get current position configuration
    const config = getCampaignPositions(campaignId)
    const currentPreset = this._detectCurrentPreset(campaignId)

    const form = document.createElement('div')
    form.className = 'cfg-position-config-form'
    form.dataset.campaignId = campaignId

    // Preset selector
    const presetGroup = document.createElement('div')
    presetGroup.className = 'cfg-form-group'

    const presetLabel = document.createElement('label')
    presetLabel.textContent = 'Position Preset'
    presetGroup.appendChild(presetLabel)

    const presetSelect = document.createElement('select')
    presetSelect.name = 'positionPreset'
    presetSelect.className = 'cfg-select'

    for (const [id, preset] of Object.entries(POSITION_PRESETS)) {
      const option = document.createElement('option')
      option.value = id
      option.textContent = `${preset.name} - ${preset.description}`
      if (id === currentPreset) option.selected = true
      presetSelect.appendChild(option)
    }

    presetGroup.appendChild(presetSelect)
    form.appendChild(presetGroup)

    // Require leader checkbox
    const leaderGroup = document.createElement('div')
    leaderGroup.className = 'cfg-form-group cfg-form-group--checkbox'

    const leaderLabel = document.createElement('label')
    const leaderCheckbox = document.createElement('input')
    leaderCheckbox.type = 'checkbox'
    leaderCheckbox.name = 'requireLeader'
    leaderCheckbox.checked = config.requireLeader || false
    leaderLabel.appendChild(leaderCheckbox)
    leaderLabel.appendChild(document.createTextNode(' Require Captain/Leader'))

    const leaderHelp = document.createElement('p')
    leaderHelp.className = 'cfg-help-text'
    leaderHelp.textContent = 'When enabled, crews must have a captain/leader assigned.'

    leaderGroup.appendChild(leaderLabel)
    leaderGroup.appendChild(leaderHelp)
    form.appendChild(leaderGroup)

    // Current positions preview
    const previewGroup = document.createElement('div')
    previewGroup.className = 'cfg-positions-preview'

    const previewLabel = document.createElement('h5')
    previewLabel.textContent = 'Current Positions:'
    previewGroup.appendChild(previewLabel)

    const positionsList = document.createElement('div')
    positionsList.className = 'cfg-positions-list'

    const positions = getSortedPositions(config.positions)
    for (const pos of positions) {
      const posItem = document.createElement('div')
      posItem.className = 'cfg-position-item'

      const icon = document.createElement('i')
      icon.className = pos.icon
      posItem.appendChild(icon)

      const name = document.createElement('span')
      name.className = 'cfg-position-name'
      name.textContent = pos.name
      posItem.appendChild(name)

      if (pos.required) {
        const reqBadge = document.createElement('span')
        reqBadge.className = 'cfg-badge cfg-badge--warning'
        reqBadge.textContent = 'Required'
        posItem.appendChild(reqBadge)
      }

      if (pos.unique) {
        const uniqBadge = document.createElement('span')
        uniqBadge.className = 'cfg-badge cfg-badge--info'
        uniqBadge.textContent = 'Unique'
        posItem.appendChild(uniqBadge)
      }

      positionsList.appendChild(posItem)
    }

    previewGroup.appendChild(positionsList)
    form.appendChild(previewGroup)

    // Save button
    const actions = document.createElement('div')
    actions.className = 'cfg-position-config-actions'

    const saveBtn = createButton('Save Position Config', {
      icon: 'fas fa-save',
      className: 'cfg-button cfg-button--primary',
      attributes: {
        'data-action': 'savePositionConfig',
        'data-campaign-id': campaignId,
      },
    })
    actions.appendChild(saveBtn)

    form.appendChild(actions)
    section.appendChild(form)

    return section
  }

  _detectCurrentPreset(campaignId) {
    const allPositions = game.settings.get(MODULE_ID, 'campaignPositions') || {}
    const config = allPositions[campaignId]

    if (!config || !config.preset) {
      return 'default'
    }

    return config.preset
  }

  _buildPartiesSection() {
    const section = document.createElement('div')
    section.className = 'cfg-section'

    // Get terminology for party label
    const terminology = window.CritFumbleCore?.getCampaignTerminology?.(this.selectedCampaignId) || {
      partyTermPlural: 'Parties',
    }

    const heading = document.createElement('h4')
    const partyCount = this.partiesHook?.parties?.length || 0
    setElementContent(heading, `${terminology.partyTermPlural} (${partyCount})`, { icon: 'fas fa-users' })
    section.appendChild(heading)

    if (!this.partiesHook || this.partiesHook.parties.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'cfg-empty-inline'
      empty.textContent = 'No parties in this campaign'
      section.appendChild(empty)
      return section
    }

    const grid = document.createElement('div')
    grid.className = 'cfg-party-grid'

    for (const party of this.partiesHook.parties) {
      const card = document.createElement('div')
      card.className = 'cfg-party-card'

      const name = document.createElement('div')
      name.className = 'cfg-party-name'
      name.textContent = party.name
      card.appendChild(name)

      const memberCount = document.createElement('div')
      memberCount.className = 'cfg-party-members'
      setElementContent(memberCount, `${party.members?.length || 0} members`, { icon: 'fas fa-user' })
      card.appendChild(memberCount)

      if (party.color) {
        card.style.borderLeftColor = party.color
      }

      grid.appendChild(card)
    }

    section.appendChild(grid)

    return section
  }

  _buildRosterSection(campaign) {
    const section = document.createElement('div')
    section.className = 'cfg-section'

    const players = campaign?.players || []
    const heading = document.createElement('h4')
    setElementContent(heading, `Player Roster (${players.length})`, { icon: 'fas fa-user-friends' })
    section.appendChild(heading)

    if (players.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'cfg-empty-inline'
      empty.textContent = 'No players synced. Click Sync to load players.'
      section.appendChild(empty)
      return section
    }

    const list = document.createElement('div')
    list.className = 'cfg-roster-list'

    for (const player of players) {
      const item = document.createElement('div')
      item.className = 'cfg-roster-item'

      const name = document.createElement('span')
      name.className = 'cfg-roster-name'
      setElementContent(name, player.user?.name || player.id, { icon: 'fas fa-user' })
      item.appendChild(name)

      const roles = document.createElement('span')
      roles.className = 'cfg-roster-roles'
      roles.textContent = player.roles?.join(', ') || 'Player'
      item.appendChild(roles)

      // Show linked actor if any
      const linkedActor = game.actors.find((a) => CampaignFlags.getPlayerId(a) === player.id)
      if (linkedActor) {
        const actor = document.createElement('span')
        actor.className = 'cfg-roster-actor'
        setElementContent(actor, linkedActor.name, { icon: 'fas fa-theater-masks' })
        item.appendChild(actor)
      }

      list.appendChild(item)
    }

    section.appendChild(list)

    return section
  }

  _buildContentStats() {
    const section = document.createElement('div')
    section.className = 'cfg-section'

    const heading = document.createElement('h4')
    setElementContent(heading, 'Content Assigned', { icon: 'fas fa-chart-bar' })
    section.appendChild(heading)

    // Count content assigned to this campaign
    const campaignId = this.selectedCampaignId
    const actorCount = CampaignFlags.findByCampaign(game.actors, campaignId).length
    const sceneCount = CampaignFlags.findByCampaign(game.scenes, campaignId).length
    const itemCount = CampaignFlags.findByCampaign(game.items, campaignId).length
    const journalCount = CampaignFlags.findByCampaign(game.journal, campaignId).length

    const stats = document.createElement('div')
    stats.className = 'cfg-content-stats'

    // Helper to create stat items
    const createStat = (icon, value, label) => {
      const stat = document.createElement('div')
      stat.className = 'cfg-stat'

      const iconEl = document.createElement('i')
      iconEl.className = icon
      stat.appendChild(iconEl)

      const valueEl = document.createElement('span')
      valueEl.className = 'cfg-stat-value'
      valueEl.textContent = value
      stat.appendChild(valueEl)

      const labelEl = document.createElement('span')
      labelEl.className = 'cfg-stat-label'
      labelEl.textContent = label
      stat.appendChild(labelEl)

      return stat
    }

    stats.appendChild(createStat('fas fa-users', actorCount, 'Actors'))
    stats.appendChild(createStat('fas fa-map', sceneCount, 'Scenes'))
    stats.appendChild(createStat('fas fa-suitcase', itemCount, 'Items'))
    stats.appendChild(createStat('fas fa-book', journalCount, 'Journals'))

    section.appendChild(stats)

    return section
  }

  _buildEmptyState(icon, title, description) {
    const empty = document.createElement('div')
    empty.className = 'cfg-empty-state'

    const iconEl = document.createElement('i')
    iconEl.className = `fas ${icon}`
    empty.appendChild(iconEl)

    const titleEl = document.createElement('h4')
    titleEl.textContent = title
    empty.appendChild(titleEl)

    const descEl = document.createElement('p')
    descEl.textContent = description
    empty.appendChild(descEl)

    return empty
  }

  _formatTimeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000)

    if (seconds < 60) return 'Just now'
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
    return `${Math.floor(seconds / 86400)}d ago`
  }

  /* -------------------------------------------- */
  /*  Action Handlers                             */
  /* -------------------------------------------- */

  static async _onLinkCampaign(event, target) {
    // Show dialog to select a campaign to link
    const available = await this.campaignsHook.fetchAvailable()

    if (available.length === 0) {
      ui.notifications.warn('No campaigns available to link. Create a campaign in the Core API first.')
      return
    }

    // Build dialog content
    const content = `
      <form>
        <div class="form-group">
          <label>Select Campaign</label>
          <select name="campaignId" required>
            <option value="">Choose a campaign...</option>
            ${available.map((c) => `<option value="${c.id}">${c.name}</option>`).join('')}
          </select>
        </div>
      </form>
    `

    new Dialog({
      title: 'Link Campaign',
      content,
      buttons: {
        link: {
          icon: '<i class="fas fa-link"></i>',
          label: 'Link',
          callback: async (html) => {
            const campaignId = html.find('[name="campaignId"]').val()
            if (!campaignId) return

            const campaign = available.find((c) => c.id === campaignId)
            await this.campaignsHook.link(campaignId, campaign.name)

            ui.notifications.success(`Linked campaign: ${campaign.name}`)
            this.render()
          },
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: 'Cancel',
        },
      },
      default: 'link',
    }).render(true)
  }

  static async _onUnlinkCampaign(event, target) {
    const campaignId = target.dataset.campaignId
    const linked = this.campaignsHook.getLinked(campaignId)

    if (!linked) return

    const confirmed = await Dialog.confirm({
      title: 'Unlink Campaign',
      content: `<p>Are you sure you want to unlink "<strong>${linked.name}</strong>"?</p>
                <p>Content associations will be preserved but the campaign will no longer sync.</p>`,
      yes: () => true,
      no: () => false,
    })

    if (confirmed) {
      await this.campaignsHook.unlink(campaignId)

      if (this.selectedCampaignId === campaignId) {
        this.selectedCampaignId = null
      }

      ui.notifications.info(`Unlinked campaign: ${linked.name}`)
      this.render()
    }
  }

  static async _onSetActiveCampaign(event, target) {
    const campaignId = target.dataset.campaignId
    await this.campaignsHook.setActive(campaignId)

    ui.sidebar.render()
    ui.notifications.info('Active campaign set. Sidebar now filters by this campaign.')
    this.render()
  }

  static async _onClearFilter(event, target) {
    await this.campaignsHook.setActive(null)

    ui.sidebar.render()
    ui.notifications.info('Campaign filter cleared. Showing all content.')
    this.render()
  }

  static async _onSelectCampaign(event, target) {
    const campaignId = target.dataset.campaignId
    this.selectedCampaignId = campaignId

    // Load parties for new selection
    this.partiesHook = new useParties(campaignId)
    await this.partiesHook.load()

    this.render()
  }

  static async _onSyncCampaign(event, target) {
    const campaignId = target.dataset.campaignId
    const syncService = window.CritFumbleCore?.syncService

    if (!syncService) {
      ui.notifications.error('Sync service not available. Configure API token in settings.')
      return
    }

    ui.notifications.info('Syncing campaign...')
    const result = await syncService.syncFromCore(campaignId)

    if (result.success) {
      await this._loadData()
      ui.notifications.success('Campaign synced successfully!')
    } else {
      ui.notifications.error(`Sync failed: ${result.error}`)
    }

    this.render()
  }

  static async _onSyncAll(event, target) {
    const syncService = window.CritFumbleCore?.syncService

    if (!syncService) {
      ui.notifications.error('Sync service not available. Configure API token in settings.')
      return
    }

    await syncService.syncAllCampaigns()
    await this._loadData()
    this.render()
  }

  static async _onOpenContentAssignment(event, target) {
    const campaignId = target.dataset.campaignId

    // For now, show a simple dialog. Will be replaced with ContentAssignmentDialog
    const linked = this.campaignsHook.getLinked(campaignId)

    new Dialog({
      title: `Assign Content to ${linked.name}`,
      content: `
        <p>Select content type to assign:</p>
        <div style="display: flex; gap: 10px; flex-wrap: wrap; margin-top: 10px;">
          <button type="button" data-type="Actor" class="cfg-button">Actors</button>
          <button type="button" data-type="Scene" class="cfg-button">Scenes</button>
          <button type="button" data-type="Item" class="cfg-button">Items</button>
          <button type="button" data-type="JournalEntry" class="cfg-button">Journals</button>
        </div>
      `,
      buttons: {
        close: {
          icon: '<i class="fas fa-times"></i>',
          label: 'Close',
        },
      },
      render: (html) => {
        html.find('button[data-type]').on('click', async (e) => {
          const type = e.currentTarget.dataset.type
          await this._openTypeAssignment(campaignId, type)
        })
      },
    }).render(true)
  }

  async _openTypeAssignment(campaignId, documentType) {
    const collection = game[documentType.toLowerCase() + 's']
    if (!collection) return

    const documents = collection.contents
    const linked = this.campaignsHook.getLinked(campaignId)

    // Build checkboxes for each document
    const items = documents
      .map((doc) => {
        const isAssigned = CampaignFlags.belongsToCampaign(doc, campaignId)
        return `
        <div class="cfg-assign-item">
          <label>
            <input type="checkbox" name="doc" value="${doc.id}" ${isAssigned ? 'checked' : ''}>
            ${doc.img ? `<img src="${doc.img}" width="24" height="24" style="margin-right: 5px;">` : ''}
            ${doc.name}
            ${isAssigned ? '<span class="cfg-badge cfg-badge--success" style="margin-left: 5px;">Assigned</span>' : ''}
          </label>
        </div>
      `
      })
      .join('')

    new Dialog(
      {
        title: `Assign ${documentType}s to ${linked.name}`,
        content: `
        <div style="max-height: 400px; overflow-y: auto;">
          <div class="cfg-assign-actions" style="margin-bottom: 10px;">
            <button type="button" id="selectAll" class="cfg-button cfg-button--small">Select All</button>
            <button type="button" id="deselectAll" class="cfg-button cfg-button--small">Deselect All</button>
          </div>
          <div class="cfg-assign-list">
            ${items}
          </div>
        </div>
      `,
        buttons: {
          save: {
            icon: '<i class="fas fa-save"></i>',
            label: 'Save',
            callback: async (html) => {
              const checked = html
                .find('input[name="doc"]:checked')
                .map((i, el) => el.value)
                .get()
              const unchecked = html
                .find('input[name="doc"]:not(:checked)')
                .map((i, el) => el.value)
                .get()

              // Add checked documents
              for (const docId of checked) {
                const doc = collection.get(docId)
                if (doc) await CampaignFlags.addToCampaign(doc, campaignId)
              }

              // Remove unchecked documents
              for (const docId of unchecked) {
                const doc = collection.get(docId)
                if (doc) await CampaignFlags.removeFromCampaign(doc, campaignId)
              }

              ui.notifications.success(`Updated ${documentType} assignments`)
              this.render()
            },
          },
          cancel: {
            icon: '<i class="fas fa-times"></i>',
            label: 'Cancel',
          },
        },
        render: (html) => {
          html.find('#selectAll').on('click', () => {
            html.find('input[name="doc"]').prop('checked', true)
          })
          html.find('#deselectAll').on('click', () => {
            html.find('input[name="doc"]').prop('checked', false)
          })
        },
      },
      { width: 500 },
    ).render(true)
  }

  static async _onSaveTerminology(event, target) {
    const campaignId = target.dataset.campaignId
    const form = this.element.querySelector('.cfg-terminology-form')

    if (!form) {
      ui.notifications.error('Could not find terminology form')
      return
    }

    const terminology = {
      partyTerm: form.querySelector('[name="partyTerm"]')?.value?.trim() || 'Party',
      partyTermPlural: form.querySelector('[name="partyTermPlural"]')?.value?.trim() || 'Parties',
      memberTerm: form.querySelector('[name="memberTerm"]')?.value?.trim() || 'Player',
      memberTermPlural: form.querySelector('[name="memberTermPlural"]')?.value?.trim() || 'Players',
      leaderTerm: form.querySelector('[name="leaderTerm"]')?.value?.trim() || 'Leader',
      unaffiliatedTerm: form.querySelector('[name="unaffiliatedTerm"]')?.value?.trim() || 'Unaffiliated',
    }

    await window.CritFumbleCore?.setCampaignTerminology?.(campaignId, terminology)
    ui.notifications.success(`Saved terminology for campaign`)

    // Re-render to update party section labels
    this.render()
  }

  static async _onSavePositionConfig(event, target) {
    const campaignId = target.dataset.campaignId
    const form = this.element.querySelector('.cfg-position-config-form')

    if (!form) {
      ui.notifications.error('Could not find position config form')
      return
    }

    const preset = form.querySelector('[name="positionPreset"]')?.value || 'default'
    const requireLeader = form.querySelector('[name="requireLeader"]')?.checked || false

    // Save position configuration
    await setCampaignPositions(campaignId, {
      preset,
      requireLeader,
    })

    ui.notifications.success('Saved position configuration')

    // Re-render to update positions preview
    this.render()
  }
}
