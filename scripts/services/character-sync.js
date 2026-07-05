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
   * Update existing actor from character data
   * @param {Actor} actor - Foundry actor
   * @param {object} character - Character data from API
   */
  async updateActorFromCharacter(actor, character) {
    // The sheet arrives either flat (`characterSheetData`, the single-character
    // GET) or nested (`sheetData.characterSheetData`, the list GET the pull-loop
    // uses). Accept both — the write-back loop feeds us the nested list shape, so
    // destructuring only the flat field would throw and strand the record
    // pending forever (cfs#17 #147).
    const sheet = character?.characterSheetData ?? character?.sheetData?.characterSheetData

    if (!sheet) {
      throw new Error('Character has no sheet data')
    }

    // The canonical platform sheet IS a Foundry actor at foundry.actor; when it
    // is present we pass its system + items through verbatim (no per-system
    // mapping, no server-side validation — it is already a valid actor).
    const foundryActor = sheet?.foundry?.actor
    const isPassThrough = !!(foundryActor && foundryActor.system && typeof foundryActor.system === 'object')

    console.log('[Character Sync] Updating actor:', { name: actor.name, characterId: character.id })

    // Only the legacy normalized shape needs server-side rules validation.
    if (!isPassThrough) {
      const validation = await this.validateCharacter(character)
      if (!validation.valid) {
        console.warn('[Character Sync] Character validation failed:', validation.errors)
        ui.notifications?.warn(`Character "${character.name}" has validation errors. Updating anyway, but please review.`)
      }
    }

    // Map character sheet to Foundry actor data (pass-through or legacy).
    const actorData = await this.mapCharacterToActorData(character)

    // Update actor scalars. `type` is immutable on an existing Actor document, so
    // it is deliberately omitted from the patch (passing it errors on v13+ when
    // the stored type ever differs from the live actor's).
    await actor.update({
      name: actorData.name,
      system: actorData.system,
      flags: {
        'crit-fumble-core': {
          characterId: character.id,
          isSyncedCharacter: true,
          lastSyncedAt: new Date().toISOString(),
        },
      },
    })

    // Item write-back. The pass-through path carries real Foundry items on
    // foundry.actor.items — apply them as embedded documents. The legacy path
    // rebuilds items from the normalized sheet via SRD compendium lookups.
    if (isPassThrough) {
      try {
        await this._applyFoundryActorItems(actor, actorData.items)
      } catch (err) {
        // Best-effort: a bad item must not block the system (HP/field) write-back.
        console.warn('[Character Sync] item write-back failed (non-fatal):', err?.message || err)
      }
    } else {
      await this.updateCharacterItems(actor, sheet)
    }

    console.log(`[Character Sync] Updated actor: ${actor.id}`)
  }

  /**
   * Reconcile the actor's embedded Item documents with the canonical
   * foundry.actor.items array (Core owns the sheet). Items are already in
   * Foundry shape, so this creates the missing ones (keeping their _id so future
   * syncs match), updates the changed ones by _id, and deletes previously-synced
   * items the platform has dropped. Deletion is limited to items WE flagged as
   * sync-managed, so GM-added items are never clobbered (cfs#17 #147).
   * @param {Actor} actor
   * @param {Array<object>} items - foundry.actor.items (may be empty)
   */
  async _applyFoundryActorItems(actor, items) {
    const stored = Array.isArray(items) ? items : []
    const storedIds = new Set(stored.filter((i) => i && i._id).map((i) => i._id))

    const toCreate = []
    const toUpdate = []
    for (const item of stored) {
      if (!item || typeof item !== 'object') continue
      const cfgFlags = { ...((item.flags && item.flags['crit-fumble-core']) || {}), isSyncedItem: true }
      const withFlag = { ...item, flags: { ...(item.flags || {}), 'crit-fumble-core': cfgFlags } }
      if (item._id && actor.items.get(item._id)) toUpdate.push(withFlag)
      else toCreate.push(withFlag)
    }

    // Delete only items we previously synced that are gone from the stored set —
    // never GM-authored items (they carry no isSyncedItem flag).
    const toDelete = actor.items
      .filter((i) => i.getFlag('crit-fumble-core', 'isSyncedItem') && !storedIds.has(i.id))
      .map((i) => i.id)

    if (toDelete.length) await actor.deleteEmbeddedDocuments('Item', toDelete)
    if (toCreate.length) await actor.createEmbeddedDocuments('Item', toCreate, { keepId: true })
    if (toUpdate.length) await actor.updateEmbeddedDocuments('Item', toUpdate)
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
    // The sheet arrives either flat (`characterSheetData`, e.g. the single-
    // character GET) or nested (`sheetData.characterSheetData`, the list GET that
    // the pull-loop uses). Accept both so write-back applies the real foundry.actor.
    const stored =
      character?.characterSheetData?.foundry?.actor ?? character?.sheetData?.characterSheetData?.foundry?.actor
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
