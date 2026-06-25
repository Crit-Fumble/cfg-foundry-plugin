/**
 * Character Sync Manager
 * Syncs characters from Core API to Foundry Actors
 */

import { FieldMapper } from '../utils/field-mapper.js'

export class CharacterSyncManager {
  /**
   * @param {CoreAPIClient} apiClient
   * @param {VTTConfigManager|null} vttConfigManager - Optional; provides data-driven field mappings
   */
  constructor(apiClient, vttConfigManager = null) {
    this.apiClient = apiClient
    this.vttConfigManager = vttConfigManager
    this.syncedCharacters = new Map() // characterId -> Actor ID
  }

  /**
   * Initialize on world ready
   */
  async initialize() {
    const campaignId = game.settings.get('crit-fumble-core', 'linkedCampaignId')
    const autoSync = game.settings.get('crit-fumble-core', 'characterSyncEnabled')

    if (!campaignId) {
      console.log('[Character Sync] No linked campaign - skipping character sync')
      return
    }

    console.log('[Character Sync] Initialized', { campaignId, autoSync })

    // Auto-sync if enabled
    if (autoSync) {
      await this.syncCharacters()
    }
  }

  /**
   * Fetch and sync all characters from Core API
   */
  async syncCharacters() {
    const campaignId = game.settings.get('crit-fumble-core', 'linkedCampaignId')

    if (!campaignId) {
      ui.notifications.warn('No linked campaign. Please link a campaign first.')
      return
    }

    try {
      ui.notifications.info('Syncing characters from Core...')

      // Fetch campaign-scoped characters (players + their PCs)
      // This is the correct endpoint — universe-wide would return all NPCs too
      const { playerCharacters, summary } = await this.apiClient.getCampaignCharacters(campaignId, { role: 'pc' })

      console.log('[Character Sync] Fetched campaign characters:', {
        total: playerCharacters?.length ?? 0,
        unassigned: summary?.unassignedPlayers ?? 0,
      })

      if (!playerCharacters || playerCharacters.length === 0) {
        ui.notifications.info(
          summary?.unassignedPlayers > 0
            ? `No characters assigned yet. ${summary.unassignedPlayers} player(s) need characters.`
            : 'No player characters found in this campaign.',
        )
        return
      }

      let syncedCount = 0
      let updatedCount = 0
      let errorCount = 0

      for (const { character, playerName } of playerCharacters) {
        try {
          // Check if already synced by Core character ID stored in actor flags
          const existingActor = this.findExistingActor(character.id)

          if (existingActor) {
            await this.updateActorFromCharacter(existingActor, character)
            console.log(`[Character Sync] Updated "${character.name}" (player: ${playerName})`)
            updatedCount++
          } else {
            await this.createActorFromCharacter(character, campaignId)
            console.log(`[Character Sync] Created "${character.name}" (player: ${playerName})`)
            syncedCount++
          }
        } catch (error) {
          console.error(`[Character Sync] Error syncing "${character.name}":`, error)
          errorCount++
        }
      }

      ui.notifications.info(
        `Created ${syncedCount}, updated ${updatedCount} character(s). ${
          errorCount > 0 ? `${errorCount} error(s).` : ''
        }`,
      )
    } catch (error) {
      console.error('[Character Sync] Error syncing characters:', error)
      ui.notifications.error('Failed to sync characters from Core.')
    }
  }

  /**
   * Find existing Actor by character ID (via flags)
   * @param {string} characterId - Character ID
   * @returns {Actor|null}
   */
  findExistingActor(characterId) {
    return game.actors.find((actor) => {
      const flagCharacterId = actor.getFlag('crit-fumble-core', 'characterId')
      return flagCharacterId === characterId
    })
  }

  /**
   * Validate character data against game rules (server-side)
   * @param {object} character - Character data to validate
   * @returns {Promise<{valid: boolean, errors: array, warnings: array}>}
   */
  async validateCharacter(character) {
    try {
      const validation = await this.apiClient.request('/api/characters/validate', {
        method: 'POST',
        body: JSON.stringify({
          character: character.characterSheetData,
          system: 'dnd5e',
          strictMode: false, // Only check errors, not warnings
        }),
      })

      return validation
    } catch (error) {
      console.error('[Character Sync] Validation error:', error)
      // If validation fails, return a default pass (don't block sync)
      return { valid: true, errors: [], warnings: [] }
    }
  }

  /**
   * Create Foundry Actor from character data
   * @param {object} character - Character data from API
   * @param {string|null} campaignId - Campaign ID (used to register foundryActorId back to Core)
   * @returns {Actor}
   */
  async createActorFromCharacter(character, campaignId = null) {
    const { id, name, characterSheetData } = character

    if (!characterSheetData) {
      throw new Error('Character has no sheet data')
    }

    console.log('[Character Sync] Creating actor:', { name, characterId: id })

    // Validate character (server-side rules enforcement)
    const validation = await this.validateCharacter(character)

    if (!validation.valid) {
      console.warn('[Character Sync] Character validation failed:', validation.errors)
      ui.notifications?.warn(`Character "${name}" has validation errors. Creating anyway, but please review.`)
    }

    if (validation.warnings?.length > 0) {
      console.log('[Character Sync] Character has warnings:', validation.warnings)
    }

    // Map character sheet to Foundry actor data
    const actorData = await this.mapCharacterToActorData(character)

    // Create actor
    const actor = await Actor.create({
      ...actorData,
      flags: {
        'crit-fumble-core': {
          characterId: id,
          isSyncedCharacter: true,
          lastSyncedAt: new Date().toISOString(),
          validationErrors: validation.errors || [],
          validationWarnings: validation.warnings || [],
        },
      },
    })

    console.log(`[Character Sync] Created actor: ${actor.id}`)

    // Add items (features, equipment, spells)
    await this.addCharacterItems(actor, characterSheetData)

    // Track synced character
    this.syncedCharacters.set(id, actor.id)

    // Register this Foundry actor ID back to Core so future Foundry→Core pushes
    // can match by foundryActorId. The response includes initial systemUpdate +
    // itemUpdates to seed the actor with Core's current pool values.
    if (campaignId) {
      try {
        const { systemUpdate, itemUpdates } = await this.apiClient.registerActorMapping(campaignId, id, actor.id)

        // Apply Core's initial HP/slot/pool values to the Foundry actor
        if (systemUpdate && Object.keys(systemUpdate).length > 0) {
          const flatUpdate = {}
          for (const [dotPath, value] of Object.entries(systemUpdate)) {
            flatUpdate[`system.${dotPath}`] = value
          }
          await actor.update(flatUpdate)
        }

        // Sync Core inventory items to Foundry (equipment, consumables, etc.)
        if (itemUpdates && itemUpdates.length > 0) {
          const itemsToCreate = itemUpdates.filter((i) => i._id === '' || !actor.items.get(i._id))
          if (itemsToCreate.length > 0) {
            await actor.createEmbeddedDocuments('Item', itemsToCreate)
          }
        }

        console.log(`[Character Sync] Registered foundryActorId "${actor.id}" on Core character "${id}"`)
      } catch (err) {
        // Non-fatal — sync will still work via characterId flag
        console.warn('[Character Sync] Could not register foundryActorId on Core:', err)
      }
    }

    return actor
  }

  /**
   * Update existing actor from character data
   * @param {Actor} actor - Foundry actor
   * @param {object} character - Character data from API
   */
  async updateActorFromCharacter(actor, character) {
    const { characterSheetData } = character

    if (!characterSheetData) {
      throw new Error('Character has no sheet data')
    }

    console.log('[Character Sync] Updating actor:', { name: actor.name, characterId: character.id })

    // Validate character (server-side rules enforcement)
    const validation = await this.validateCharacter(character)

    if (!validation.valid) {
      console.warn('[Character Sync] Character validation failed:', validation.errors)
      ui.notifications?.warn(`Character "${character.name}" has validation errors. Updating anyway, but please review.`)
    }

    // Map character sheet to Foundry actor data
    const actorData = await this.mapCharacterToActorData(character)

    // Update actor (exclude items, we'll handle those separately)
    await actor.update({
      name: actorData.name,
      type: actorData.type,
      system: actorData.system,
      flags: {
        'crit-fumble-core': {
          characterId: character.id,
          isSyncedCharacter: true,
          lastSyncedAt: new Date().toISOString(),
          validationErrors: validation.errors || [],
          validationWarnings: validation.warnings || [],
        },
      },
    })

    // Update items
    await this.updateCharacterItems(actor, characterSheetData)

    console.log(`[Character Sync] Updated actor: ${actor.id}`)
  }

  /**
   * Map a Core character to Foundry actor data.
   *
   * cfs#17 #147: the platform's canonical sheet IS a Foundry actor stored at
   * `characterSheetData.foundry.actor`, so we pass its `system` (and items)
   * through VERBATIM — no per-system field mapping. Falls back to the legacy
   * normalized mapper only for pre-Phase-2 characters that have no foundry.actor.
   *
   * @param {object} character - Character from API
   * @returns {object} Foundry actor data
   */
  async mapCharacterToActorData(character) {
    const stored = character?.characterSheetData?.foundry?.actor
    if (stored && stored.system && typeof stored.system === 'object') {
      return {
        name: stored.name || character.name,
        type: stored.type || 'character',
        system: stored.system,
        items: Array.isArray(stored.items) ? stored.items : [],
      }
    }
    return this._mapLegacyCharacterToActorData(character)
  }

  /**
   * Legacy normalized → dnd5e mapper (pre-Phase-2 characters with no foundry.actor).
   * @param {object} character - Character from API
   * @returns {object} Foundry actor data
   */
  async _mapLegacyCharacterToActorData(character) {
    const { name, characterSheetData } = character
    const sheet = characterSheetData

    // Map abilities
    const abilities = {}
    if (sheet.abilities) {
      Object.entries(sheet.abilities).forEach(([ability, data]) => {
        abilities[ability] = {
          value: data.score,
          proficient: 0, // Ability save proficiencies (not implemented in Core yet)
        }
      })
    }

    // Map skills
    const skills = {}
    if (sheet.skills) {
      Object.entries(sheet.skills).forEach(([skill, data]) => {
        const skillKey = this.mapSkillToFoundryKey(skill)
        if (skillKey) {
          skills[skillKey] = {
            value: data.proficient || 0, // 0 = no prof, 1 = proficient, 2 = expertise
            ability: this.getSkillAbility(skill),
          }
        }
      })
    }

    // Map spell slots
    const spells = {}
    if (sheet.spells?.spellSlots) {
      Object.entries(sheet.spells.spellSlots).forEach(([level, slots]) => {
        spells[`spell${level}`] = {
          value: slots.current,
          max: slots.max,
          override: null,
        }
      })
    }

    // Get primary class (first in array)
    const primaryClass = sheet.classes?.[0]

    // Build actor data (hardcoded mapping handles data shape differences)
    const actorData = {
      name,
      type: 'character',
      system: {
        abilities,

        attributes: {
          hp: {
            value: sheet.resources?.hp?.current || 0,
            max: sheet.resources?.hp?.max || 0,
            temp: sheet.resources?.hp?.temp || 0,
            tempmax: 0,
          },
          ac: {
            flat: sheet.combat?.ac || 10,
            calc: 'default',
            formula: '',
          },
          init: {
            ability: 'dex',
            bonus: 0,
          },
          movement: {
            burrow: 0,
            climb: 0,
            fly: 0,
            swim: 0,
            walk: sheet.combat?.speed || 30,
            units: 'ft',
            hover: false,
          },
        },

        details: {
          biography: {
            value: '',
            public: '',
          },
          species: this.capitalizeWords(sheet.species || 'Human'),
          background: this.capitalizeWords(sheet.background || ''),
          level: sheet.progression?.level || 1,
          xp: {
            value: sheet.progression?.xp || 0,
          },
        },

        traits: {
          size: 'med', // Default; Foundry system derives size from species data
          senses: '',
          languages: {
            value: [],
            custom: '',
          },
          di: { value: [], custom: '' },
          dr: { value: [], custom: '' },
          dv: { value: [], custom: '' },
          ci: { value: [], custom: '' },
        },

        skills,
        spells,

        attributes: {
          ...{
            hp: {
              value: sheet.resources?.hp?.current || 0,
              max: sheet.resources?.hp?.max || 0,
              temp: sheet.resources?.hp?.temp || 0,
              tempmax: 0,
            },
          },
          hd: {
            value: sheet.resources?.hitDice?.current || 1,
            max: sheet.resources?.hitDice?.max || 1,
          },
        },

        spellcasting: sheet.spells?.spellcastingAbility || 'int',
      },
    }

    // Overlay data-driven field mappings from VTT config (if available).
    // The FieldMapper reads the `characterSheetData` shape stored in Core and
    // applies simple path-to-path copies. For normalized characters whose
    // characterSheetData mirrors Foundry's structure, this provides precise
    // per-field accuracy for skills, currencies, spell slots, etc.
    const fieldMapper = this.vttConfigManager?.getFieldMapper()
    if (fieldMapper) {
      try {
        const mapped = fieldMapper.coreToFoundry('actor', 'character', character)
        if (mapped && Object.keys(mapped).length > 0) {
          this._deepMerge(actorData, mapped)
        }
      } catch (err) {
        console.warn('[Character Sync] FieldMapper error (using hardcoded data):', err)
      }
    }

    return actorData
  }

  /**
   * Deep merge source into target (mutates target).
   * Source values override target values for scalars; objects are merged recursively.
   * @param {object} target
   * @param {object} source
   * @returns {object} target
   */
  _deepMerge(target, source) {
    for (const [key, value] of Object.entries(source)) {
      if (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        target[key] !== null &&
        typeof target[key] === 'object' &&
        !Array.isArray(target[key])
      ) {
        this._deepMerge(target[key], value)
      } else if (value !== undefined) {
        target[key] = value
      }
    }
    return target
  }

  /**
   * Add character items (features, equipment, spells) to actor
   * @param {Actor} actor - Foundry actor
   * @param {object} sheet - Character sheet data
   */
  async addCharacterItems(actor, sheet) {
    const items = []

    // Add features
    if (sheet.features) {
      for (const feature of sheet.features) {
        items.push({
          name: feature.name,
          type: 'feat',
          system: {
            description: {
              value: `<p>Source: ${feature.source}</p>`,
              chat: '',
              unidentified: '',
            },
            source: feature.source,
            activation: { type: '', cost: null, condition: '' },
            duration: { value: null, units: '' },
            target: { value: null, width: null, units: '', type: '' },
            range: { value: null, long: null, units: '' },
            uses: { value: null, max: null, per: null },
            consume: { type: '', target: null, amount: null },
            ability: null,
            actionType: '',
            attackBonus: '',
            chatFlavor: '',
            critical: { threshold: null, damage: '' },
            damage: { parts: [], versatile: '' },
            formula: '',
            save: { ability: '', dc: null, scaling: 'spell' },
            requirements: '',
            recharge: { value: null, charged: false },
          },
        })
      }
    }

    // Add equipment (simplified - just create basic items)
    if (sheet.equipment) {
      for (const equipmentName of sheet.equipment) {
        // Try to find in SRD compendiums first
        const srdItem = await this.findSRDItem(equipmentName)
        if (srdItem) {
          items.push(srdItem.toObject())
        } else {
          // Create placeholder item
          items.push({
            name: equipmentName,
            type: 'equipment',
            system: {
              description: { value: `<p>${equipmentName}</p>` },
              quantity: 1,
              weight: 0,
              price: { value: 0, denomination: 'gp' },
              equipped: false,
              identified: true,
            },
          })
        }
      }
    }

    // Add spells (cantrips and prepared)
    if (sheet.spells) {
      const allSpells = [...(sheet.spells.cantrips || []), ...(sheet.spells.prepared || [])]

      for (const spellName of allSpells) {
        const srdSpell = await this.findSRDSpell(spellName)
        if (srdSpell) {
          const spellData = srdSpell.toObject()
          spellData.system.preparation = {
            mode: sheet.spells.cantrips?.includes(spellName) ? 'always' : 'prepared',
            prepared: true,
          }
          items.push(spellData)
        }
      }
    }

    // Create items on actor
    if (items.length > 0) {
      await actor.createEmbeddedDocuments('Item', items)
      console.log(`[Character Sync] Added ${items.length} item(s) to actor`)
    }
  }

  /**
   * Update character items
   * @param {Actor} actor - Foundry actor
   * @param {object} sheet - Character sheet data
   */
  async updateCharacterItems(actor, sheet) {
    // For now, just delete all synced items and re-add them
    // TODO: Implement smart diffing to preserve user modifications
    const syncedItems = actor.items.filter((item) => item.getFlag('crit-fumble-core', 'isSyncedItem'))

    if (syncedItems.length > 0) {
      await actor.deleteEmbeddedDocuments(
        'Item',
        syncedItems.map((i) => i.id),
      )
    }

    await this.addCharacterItems(actor, sheet)
  }

  /**
   * Find SRD item in compendiums
   * @param {string} itemName - Item name
   * @returns {Item|null}
   */
  async findSRDItem(itemName) {
    const normalizedName = itemName.toLowerCase().trim()
    const compendiums = game.packs.filter((p) => p.documentName === 'Item')

    for (const pack of compendiums) {
      const index = await pack.getIndex()
      const entry = index.find((e) => e.name.toLowerCase().trim() === normalizedName)

      if (entry) {
        const document = await pack.getDocument(entry._id)
        if (document && document.type !== 'spell') {
          return document
        }
      }
    }

    return null
  }

  /**
   * Find SRD spell in compendiums
   * @param {string} spellName - Spell name
   * @returns {Item|null}
   */
  async findSRDSpell(spellName) {
    const normalizedName = spellName.toLowerCase().trim()
    const compendiums = game.packs.filter((p) => p.documentName === 'Item')

    for (const pack of compendiums) {
      const index = await pack.getIndex()
      const entry = index.find((e) => e.name.toLowerCase().trim() === normalizedName)

      if (entry) {
        const document = await pack.getDocument(entry._id)
        if (document && document.type === 'spell') {
          return document
        }
      }
    }

    return null
  }

  /**
   * Sync character changes back to Core API (bi-directional sync)
   * @param {Actor} actor - Foundry actor to sync
   */
  async syncToCore(actor) {
    const characterId = actor.getFlag('crit-fumble-core', 'characterId')
    const campaignId = game.settings.get('crit-fumble-core', 'linkedCampaignId')

    if (!characterId) {
      ui.notifications.warn('This actor is not linked to a Core character.')
      return
    }

    try {
      ui.notifications.info(`Syncing ${actor.name} to Core...`)

      if (campaignId) {
        // Push actor data to Core — Core detects conflicts and applies clean changes.
        // Conflicts are surfaced on the Core VTT page for the GM to resolve.
        const result = await this.apiClient.pushActorSync(campaignId, [
          {
            _id: actor.id,
            name: actor.name,
            system: actor.system,
            items: actor.items.map((i) => i.toObject()),
          },
        ])

        if (result.conflict > 0) {
          ui.notifications.warn(
            `${actor.name}: ${result.conflict} sync conflict(s) detected. Resolve them on the Core VTT page.`,
          )
        }
      } else {
        // No campaign context — reverse sync requires a linked campaign
        console.warn('[Character Sync] syncToCore requires a linked campaign; skipping reverse sync')
        ui.notifications.warn('Link a campaign before pushing character data to Core.')
        return
      }

      // Update sync timestamp flag
      await actor.setFlag('crit-fumble-core', 'lastSyncedAt', new Date().toISOString())

      ui.notifications.info(`Synced ${actor.name} to Core successfully.`)
    } catch (error) {
      console.error('[Character Sync] Error syncing to Core:', error)
      ui.notifications.error(`Failed to sync ${actor.name} to Core.`)
    }
  }

  /**
   * Refresh characters (re-sync from API)
   */
  async refresh() {
    console.log('[Character Sync] Refreshing characters...')
    await this.syncCharacters()
  }

  /**
   * Clear all synced characters
   */
  async clearSyncedCharacters() {
    if (!game.user.isGM) {
      ui.notifications.warn('Only GMs can clear synced characters.')
      return
    }

    const confirmed = await Dialog.confirm({
      title: 'Clear Synced Characters',
      content: '<p>Delete all synced character actors?</p><p>This cannot be undone.</p>',
    })

    if (!confirmed) return

    try {
      const actorsToDelete = game.actors.filter((actor) => {
        return actor.getFlag('crit-fumble-core', 'isSyncedCharacter')
      })

      for (const actor of actorsToDelete) {
        await actor.delete()
      }

      this.syncedCharacters.clear()

      ui.notifications.info(`Deleted ${actorsToDelete.length} synced character(s).`)
    } catch (error) {
      console.error('[Character Sync] Error clearing synced characters:', error)
      ui.notifications.error('Failed to clear synced characters.')
    }
  }

  /* -------------------------------------------- */
  /*  Helper Methods                              */
  /* -------------------------------------------- */

  /**
   * Map Core skill name to Foundry skill key
   * @param {string} skill - Core skill name
   * @returns {string|null}
   */
  mapSkillToFoundryKey(skill) {
    const mapping = {
      acrobatics: 'acr',
      'animal-handling': 'ani',
      arcana: 'arc',
      athletics: 'ath',
      deception: 'dec',
      history: 'his',
      insight: 'ins',
      intimidation: 'itm',
      investigation: 'inv',
      medicine: 'med',
      nature: 'nat',
      perception: 'prc',
      performance: 'prf',
      persuasion: 'per',
      religion: 'rel',
      'sleight-of-hand': 'slt',
      stealth: 'ste',
      survival: 'sur',
    }
    return mapping[skill] || null
  }

  /**
   * Get ability for a skill
   * @param {string} skill - Skill name
   * @returns {string}
   */
  getSkillAbility(skill) {
    const skillAbilities = {
      acrobatics: 'dex',
      'animal-handling': 'wis',
      arcana: 'int',
      athletics: 'str',
      deception: 'cha',
      history: 'int',
      insight: 'wis',
      intimidation: 'cha',
      investigation: 'int',
      medicine: 'wis',
      nature: 'int',
      perception: 'wis',
      performance: 'cha',
      persuasion: 'cha',
      religion: 'int',
      'sleight-of-hand': 'dex',
      stealth: 'dex',
      survival: 'wis',
    }
    return skillAbilities[skill] || 'int'
  }

  /**
   * Capitalize each word in a string
   * @param {string} str - Input string
   * @returns {string}
   */
  capitalizeWords(str) {
    if (!str) return ''
    return str
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
  }
}
