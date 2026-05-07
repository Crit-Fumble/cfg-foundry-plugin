/**
 * UI Components Central Export
 * Single import point for all atomic design components
 */

// Atoms
import { Button } from './atoms/Button.js'
import { Select } from './atoms/Select.js'
import { Badge } from './atoms/Badge.js'
import { Avatar } from './atoms/Avatar.js'
import { EmptyState } from './atoms/EmptyState.js'

// Molecules
import { FormGroup } from './molecules/FormGroup.js'
import { Card } from './molecules/Card.js'
import { PanelHeader } from './molecules/PanelHeader.js'
import { ListContainer } from './molecules/ListContainer.js'

// Re-export for external use
export { Button, Select, Badge, Avatar, EmptyState }
export { FormGroup, Card, PanelHeader, ListContainer }

/**
 * Get combined CSS for all components
 */
export function getComponentStyles() {
  return `
    /* ========================================
       CFG UI Components - Atomic Design System
       ======================================== */

    ${Button.getStyles()}
    ${Select.getStyles()}
    ${Badge.getStyles()}
    ${Avatar.getStyles()}
    ${EmptyState.getStyles()}
    ${FormGroup.getStyles()}
    ${Card.getStyles()}
    ${PanelHeader.getStyles()}
    ${ListContainer.getStyles()}
  `
}

/**
 * Inject component styles into document (lazy-loaded)
 */
let stylesInjected = false
export function injectComponentStyles() {
  // Check if styles already injected
  if (stylesInjected || document.getElementById('cfg-component-styles')) {
    return
  }

  const styleEl = document.createElement('style')
  styleEl.id = 'cfg-component-styles'
  styleEl.textContent = getComponentStyles()
  document.head.appendChild(styleEl)

  stylesInjected = true
  console.log('[CFG UI Components] Styles injected (lazy)')
}

/**
 * Ensure styles are loaded before rendering
 */
export function ensureStyles() {
  if (!stylesInjected) {
    injectComponentStyles()
  }
}
