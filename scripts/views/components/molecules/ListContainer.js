/**
 * List Container Molecule
 * Scrollable container for lists with optional empty state
 */

import { EmptyState } from '../atoms/EmptyState.js'

export class ListContainer {
  /**
   * Create a list container element
   * @param {Object} options - List container options
   * @param {Array} options.items - Array of item elements
   * @param {Object} options.emptyState - Empty state options (if items is empty)
   * @param {string} options.className - Additional CSS class
   * @returns {HTMLElement}
   */
  static create(options = {}) {
    const { items = [], emptyState = null, className = '' } = options

    const container = document.createElement('div')
    container.className = `cfg-list-container ${className}`

    if (items.length > 0) {
      items.forEach((item) => container.appendChild(item))
    } else if (emptyState) {
      const empty = EmptyState.create(emptyState)
      container.appendChild(empty)
    }

    return container
  }

  /**
   * Get CSS for list container styling
   */
  static getStyles() {
    return `
      .cfg-list-container {
        flex: 1;
        overflow-y: auto;
        overflow-x: hidden;
        padding: 8px;
        min-height: 0;
      }

      /* Scrollbar styling */
      .cfg-list-container::-webkit-scrollbar {
        width: 8px;
      }

      .cfg-list-container::-webkit-scrollbar-track {
        background: var(--cfg-bg-primary, #1a1a1a);
      }

      .cfg-list-container::-webkit-scrollbar-thumb {
        background: var(--cfg-bg-tertiary, #444);
        border-radius: 4px;
      }

      .cfg-list-container::-webkit-scrollbar-thumb:hover {
        background: var(--cfg-border, #555);
      }
    `
  }
}
