/**
 * Panel Header Molecule
 * Section header with title, icon, and optional count badge
 */

export class PanelHeader {
  /**
   * Create a panel header element
   * @param {Object} options - Panel header options
   * @param {string} options.title - Header title
   * @param {string} options.icon - Font Awesome icon class
   * @param {number} options.count - Optional count to display
   * @param {Array} options.actions - Optional action buttons
   * @returns {HTMLElement}
   */
  static create(options = {}) {
    const { title = '', icon = null, count = null, actions = [] } = options

    const header = document.createElement('div')
    header.className = 'cfg-panel-header'

    // Title with icon
    const titleContainer = document.createElement('div')
    titleContainer.className = 'cfg-panel-header__title'

    if (icon) {
      const iconEl = document.createElement('i')
      iconEl.className = `fas ${icon}`
      titleContainer.appendChild(iconEl)
      titleContainer.appendChild(document.createTextNode(' '))
    }

    const titleText = document.createElement('span')
    titleText.textContent = title
    titleContainer.appendChild(titleText)

    header.appendChild(titleContainer)

    // Right side (count and actions)
    const rightSide = document.createElement('div')
    rightSide.className = 'cfg-panel-header__right'

    // Count badge
    if (count !== null) {
      const countBadge = document.createElement('span')
      countBadge.className = 'cfg-panel-header__count'
      countBadge.textContent = count
      rightSide.appendChild(countBadge)
    }

    // Actions
    if (actions.length > 0) {
      const actionsContainer = document.createElement('div')
      actionsContainer.className = 'cfg-panel-header__actions'
      actions.forEach((action) => actionsContainer.appendChild(action))
      rightSide.appendChild(actionsContainer)
    }

    if (count !== null || actions.length > 0) {
      header.appendChild(rightSide)
    }

    return header
  }

  /**
   * Get CSS for panel header styling
   */
  static getStyles() {
    return `
      .cfg-panel-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 16px;
        background: var(--cfg-bg-secondary, #2a2a2a);
        border-bottom: 1px solid var(--cfg-border, #444);
      }

      .cfg-panel-header__title {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 14px;
        font-weight: bold;
        color: var(--cfg-text-primary, #e0e0e0);
      }

      .cfg-panel-header__title i {
        color: var(--cfg-accent, #4a90e2);
      }

      .cfg-panel-header__right {
        display: flex;
        align-items: center;
        gap: 12px;
      }

      .cfg-panel-header__count {
        padding: 2px 8px;
        background: var(--cfg-bg-tertiary, #444);
        border-radius: 12px;
        font-size: 11px;
        font-weight: bold;
        color: var(--cfg-text-primary, #e0e0e0);
      }

      .cfg-panel-header__actions {
        display: flex;
        gap: 4px;
      }
    `
  }
}
