/**
 * Empty State Atom
 * Display component for empty lists/sections
 */

export class EmptyState {
  /**
   * Create an empty state element
   * @param {Object} options - Empty state options
   * @param {string} options.icon - Font Awesome icon class
   * @param {string} options.title - Main message
   * @param {string} options.subtitle - Optional secondary message
   * @returns {HTMLElement}
   */
  static create(options = {}) {
    const { icon = 'fa-inbox', title = 'No items', subtitle = null } = options

    const container = document.createElement('div')
    container.className = 'cfg-empty-state'

    const iconEl = document.createElement('i')
    iconEl.className = `fas ${icon}`
    container.appendChild(iconEl)

    const titleEl = document.createElement('p')
    titleEl.className = 'cfg-empty-state__title'
    titleEl.textContent = title
    container.appendChild(titleEl)

    if (subtitle) {
      const subtitleEl = document.createElement('p')
      subtitleEl.className = 'cfg-empty-state__subtitle'
      subtitleEl.textContent = subtitle
      container.appendChild(subtitleEl)
    }

    return container
  }

  /**
   * Get CSS for empty state styling
   */
  static getStyles() {
    return `
      .cfg-empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 48px 24px;
        color: var(--cfg-text-muted, #888);
        text-align: center;
      }

      .cfg-empty-state i {
        font-size: 48px;
        margin-bottom: 16px;
        opacity: 0.3;
      }

      .cfg-empty-state__title {
        margin: 0 0 8px 0;
        font-size: 14px;
        font-weight: bold;
        color: var(--cfg-text-secondary, #aaa);
      }

      .cfg-empty-state__subtitle {
        margin: 0;
        font-size: 12px;
        color: var(--cfg-text-muted, #888);
      }
    `
  }
}
