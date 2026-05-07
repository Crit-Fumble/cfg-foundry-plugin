/**
 * Field Mapper
 *
 * Applies bidirectional dot-notation path mappings between Core and Foundry data shapes.
 * Reads from the VTT config fetched via /api/game-data/[system]/vtt-config.
 *
 * Path format: 'a.b.c' maps to/from nested object { a: { b: { c: value } } }
 */

/**
 * Get a nested value from an object using a dot-notation path.
 * @param {object} obj - Source object
 * @param {string} path - Dot-notation path (e.g. 'system.abilities.str.value')
 * @returns {*} Value at path, or undefined if not found
 */
export function getByPath(obj, path) {
  return path.split('.').reduce((current, key) => {
    return current != null ? current[key] : undefined
  }, obj)
}

/**
 * Set a nested value on an object using a dot-notation path, creating intermediate
 * objects as needed.
 * @param {object} obj - Target object (mutated in place)
 * @param {string} path - Dot-notation path (e.g. 'system.abilities.str.value')
 * @param {*} value - Value to set
 */
export function setByPath(obj, path, value) {
  const keys = path.split('.')
  let current = obj
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]
    if (current[key] == null || typeof current[key] !== 'object') {
      current[key] = {}
    }
    current = current[key]
  }
  current[keys[keys.length - 1]] = value
}

/**
 * Apply a flat path-mapping dictionary to transform source data into target data.
 *
 * @param {object} source - Source data object
 * @param {Record<string, string>} mappings - Dictionary of { sourcePath: targetPath }
 * @param {object} [base={}] - Base target object to merge into
 * @returns {object} Target object with mapped fields applied
 */
export function applyMappings(source, mappings, base = {}) {
  const result = JSON.parse(JSON.stringify(base)) // deep clone base

  for (const [sourcePath, targetPath] of Object.entries(mappings)) {
    const value = getByPath(source, sourcePath)
    if (value !== undefined) {
      setByPath(result, targetPath, value)
    }
  }

  return result
}

/**
 * FieldMapper
 *
 * Uses VTT config fieldMappings to apply bidirectional transforms between
 * Core data and Foundry document data.
 *
 * Usage:
 *   const mapper = new FieldMapper(vttConfig.fieldMappings);
 *   const foundryData = mapper.coreToFoundry('actor', 'character', coreCharacter);
 *   const coreData   = mapper.foundryToCore('actor', 'character', foundryActor);
 */
export class FieldMapper {
  /**
   * @param {object} fieldMappings - The fieldMappings section from vtt-config response.
   *   Shape: { actor: { character: { coreToFoundry, foundryToCore }, ... }, item: {...}, scene: {...} }
   */
  constructor(fieldMappings) {
    this.fieldMappings = fieldMappings || {}
  }

  /**
   * Get the mapping dict for a document type + subtype in a given direction.
   * @param {'actor'|'item'|'scene'} docType
   * @param {string} subtype - e.g. 'character', 'npc', 'weapon', 'spell'
   * @param {'coreToFoundry'|'foundryToCore'} direction
   * @returns {Record<string,string>|null}
   */
  getMappings(docType, subtype, direction) {
    return this.fieldMappings?.[docType]?.[subtype]?.[direction] ?? null
  }

  /**
   * Transform Core data → Foundry document data using configured mappings.
   * @param {'actor'|'item'|'scene'} docType
   * @param {string} subtype - e.g. 'character'
   * @param {object} coreData - Core data object (character, item, etc.)
   * @param {object} [base={}] - Base Foundry document shape to merge into
   * @returns {object} Foundry-shaped data with mapped fields
   */
  coreToFoundry(docType, subtype, coreData, base = {}) {
    const mappings = this.getMappings(docType, subtype, 'coreToFoundry')
    if (!mappings) {
      console.warn(`[FieldMapper] No coreToFoundry mappings for ${docType}.${subtype}`)
      return base
    }
    return applyMappings(coreData, mappings, base)
  }

  /**
   * Transform Foundry document data → Core data using configured mappings.
   * @param {'actor'|'item'|'scene'} docType
   * @param {string} subtype - e.g. 'character'
   * @param {object} foundryData - Foundry document data
   * @param {object} [base={}] - Base Core data shape to merge into
   * @returns {object} Core-shaped data with mapped fields
   */
  foundryToCore(docType, subtype, foundryData, base = {}) {
    const mappings = this.getMappings(docType, subtype, 'foundryToCore')
    if (!mappings) {
      console.warn(`[FieldMapper] No foundryToCore mappings for ${docType}.${subtype}`)
      return base
    }
    return applyMappings(foundryData, mappings, base)
  }

  /**
   * Map a Core character role to a Foundry actor type using roleMappings.
   * @param {object} roleMappings - The roleMappings section from vtt-config response
   * @param {string} coreRole - Core role (e.g. 'pc', 'npc')
   * @returns {string} Foundry actor type (e.g. 'character', 'npc')
   */
  static coreRoleToFoundryType(roleMappings, coreRole) {
    return roleMappings?.coreToFoundry?.[coreRole] ?? 'character'
  }

  /**
   * Map a Foundry actor type to a Core character role using roleMappings.
   * @param {object} roleMappings - The roleMappings section from vtt-config response
   * @param {string} foundryType - Foundry actor type (e.g. 'character', 'npc')
   * @returns {string} Core role (e.g. 'pc', 'npc')
   */
  static foundryTypeToCore(roleMappings, foundryType) {
    return roleMappings?.foundryToCore?.[foundryType] ?? 'npc'
  }
}
