/**
 * VTT Config Manager
 *
 * Fetches and caches the VTT integration config from Core API at world startup.
 * Config drives bidirectional field mapping for actors, items, and scenes — the
 * same mechanism works for any game system (cfg5e, cypher, swade, etc.) as long
 * as the system has field mappings seeded in the database.
 *
 * Config is fetched from: GET /api/game-data/[system]/vtt-config
 * Requires API key with scope "read:vtt-config".
 *
 * Shape returned by Core:
 * {
 *   system: 'cfg5e',
 *   systemName: 'CFG 5e',
 *   foundrySystemId: 'dnd5e',
 *   foundrySettings: { ... },
 *   fieldMappings: {
 *     actor: { character: { coreToFoundry, foundryToCore }, npc: { ... } },
 *     item: { weapon: { ... }, spell: { ... }, ... },
 *     scene: { dungeon: { ... } }
 *   },
 *   roleMappings: { coreToFoundry: { pc: 'character', ... }, foundryToCore: { ... } }
 * }
 */

import { FieldMapper } from '../utils/field-mapper.js'

const MODULE_ID = 'crit-fumble-core'

export class VTTConfigManager {
  constructor(apiClient) {
    this.apiClient = apiClient
    this._config = null
    this._fetchPromise = null
    this._lastFetchAt = null
    // Cache TTL: 5 minutes (matches Cache-Control on the endpoint)
    this._cacheTtlMs = 5 * 60 * 1000
  }

  /**
   * Detect the Core system slug from the Foundry game system id.
   * Foundry's game.system.id is the Foundry package id (e.g. 'dnd5e').
   * We map this to the Core slug via the module setting 'coreSystemSlug' if set;
   * otherwise fall back to well-known mappings.
   * @returns {string}
   */
  _getCoreSystemSlug() {
    // Prefer explicit module setting
    try {
      const explicit = game.settings.get(MODULE_ID, 'coreSystemSlug')
      if (explicit) return explicit
    } catch (_) {
      /* setting not registered yet */
    }

    // Fall back: map known Foundry system ids to Core system slugs.
    // Core slugs match what the seeder creates in core_game_systems.slug:
    //   '5e-compatible' - SRD 5.2 base (standard Foundry dnd5e worlds)
    //   'rotfs'         - RotFS expansion worlds
    //   'cypher'        - Cypher
    const FOUNDRY_TO_CORE = {
      dnd5e: '5e-compatible',
      pf2e: 'pf2e',
      cypher: 'cypher',
    }

    return FOUNDRY_TO_CORE[game.system.id] ?? game.system.id
  }

  /**
   * Fetch the VTT config from Core (with in-memory caching).
   * Safe to call multiple times — will reuse inflight fetch.
   * @param {boolean} [force=false] - Bypass cache and refetch
   * @returns {Promise<object|null>} Config object or null on failure
   */
  async fetchConfig(force = false) {
    // Return cached if fresh
    if (!force && this._config && this._lastFetchAt) {
      const age = Date.now() - this._lastFetchAt
      if (age < this._cacheTtlMs) {
        return this._config
      }
    }

    // Deduplicate concurrent fetches
    if (this._fetchPromise) {
      return this._fetchPromise
    }

    this._fetchPromise = this._doFetch().finally(() => {
      this._fetchPromise = null
    })

    return this._fetchPromise
  }

  async _doFetch() {
    const slug = this._getCoreSystemSlug()

    try {
      console.log(`[VTTConfig] Fetching config for system "${slug}"...`)
      const config = await this.apiClient.request(`/api/game-data/${slug}/vtt-config`)

      this._config = config
      this._lastFetchAt = Date.now()

      console.log(`[VTTConfig] Loaded config for "${config.systemName}" (Foundry: ${config.foundrySystemId})`, {
        actorTypes: Object.keys(config.fieldMappings?.actor ?? {}),
        itemTypes: Object.keys(config.fieldMappings?.item ?? {}),
        sceneTypes: Object.keys(config.fieldMappings?.scene ?? {}),
      })

      return config
    } catch (error) {
      console.error(`[VTTConfig] Failed to fetch config for system "${slug}":`, error)
      return null
    }
  }

  /**
   * Get a FieldMapper instance backed by the current cached config.
   * Returns null if config hasn't been fetched yet.
   * @returns {FieldMapper|null}
   */
  getFieldMapper() {
    if (!this._config) return null
    return new FieldMapper(this._config.fieldMappings)
  }

  /**
   * Get the role mappings section of the current config.
   * @returns {object|null}
   */
  getRoleMappings() {
    return this._config?.roleMappings ?? null
  }

  /**
   * Get the full config (or null if not yet fetched).
   * @returns {object|null}
   */
  getConfig() {
    return this._config
  }

  /**
   * Initialize by fetching config. Call once from module's 'ready' hook.
   * Non-fatal: if fetch fails, sync will fall back to hardcoded logic.
   */
  async initialize() {
    const config = await this.fetchConfig()
    if (!config) {
      console.warn('[VTTConfig] Could not load VTT config from Core. Field mapping will use hardcoded fallbacks.')
    }
    return config
  }
}
