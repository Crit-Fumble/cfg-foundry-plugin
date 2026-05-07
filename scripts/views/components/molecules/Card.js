/**
 * Card Molecule
 * Content card with optional avatar, title, subtitle, and actions
 */

import { Avatar } from '../atoms/Avatar.js'
import { Badge } from '../atoms/Badge.js'

export class Card {
  /**
   * Create a card element
   * @param {Object} options - Card options
   * @param {string} options.avatarSrc - Avatar image source
   * @param {string} options.avatarIcon - Avatar fallback icon
   * @param {string} options.title - Card title
   * @param {string} options.subtitle - Card subtitle
   * @param {Array} options.badges - Array of badge options
   * @param {Array} options.actions - Array of button elements
   * @param {boolean} options.selected - Whether card is selected
   * @param {Function} options.onClick - Click handler
   * @param {Object} options.dataset - Data attributes
   * @returns {HTMLElement}
   */
  static create(options = {}) {
    const {
      avatarSrc = '',
      avatarIcon = 'fa-user',
      title = '',
      subtitle = '',
      badges = [],
      actions = [],
      selected = false,
      onClick = null,
      dataset = {},
    } = options

    const card = document.createElement('div')
    card.className = `cfg-card ${selected ? 'cfg-card--selected' : ''}`

    // Add avatar
    if (avatarSrc || avatarIcon) {
      const avatar = Avatar.create({
        src: avatarSrc,
        alt: title,
        fallbackIcon: avatarIcon,
      })
      card.appendChild(avatar)
    }

    // Add content
    const content = document.createElement('div')
    content.className = 'cfg-card__content'

    // Title with badges
    const titleRow = document.createElement('div')
    titleRow.className = 'cfg-card__title'
    titleRow.textContent = title

    badges.forEach((badgeOpts) => {
      const badge = Badge.create(badgeOpts)
      titleRow.appendChild(document.createTextNode(' '))
      titleRow.appendChild(badge)
    })

    content.appendChild(titleRow)

    // Subtitle
    if (subtitle) {
      const subtitleEl = document.createElement('div')
      subtitleEl.className = 'cfg-card__subtitle'

      // Support both DOM elements and strings
      if (subtitle instanceof HTMLElement) {
        subtitleEl.appendChild(subtitle)
      } else if (typeof subtitle === 'string') {
        // For strings, use textContent for safety
        subtitleEl.textContent = subtitle
      }

      content.appendChild(subtitleEl)
    }

    card.appendChild(content)

    // Add actions
    if (actions.length > 0) {
      const actionsContainer = document.createElement('div')
      actionsContainer.className = 'cfg-card__actions'
      actions.forEach((action) => actionsContainer.appendChild(action))
      card.appendChild(actionsContainer)
    }

    // Add data attributes
    Object.entries(dataset).forEach(([key, value]) => {
      card.dataset[key] = value
    })

    // Add click handler
    if (onClick) {
      card.style.cursor = 'pointer'
      card.addEventListener('click', onClick)
    }

    return card
  }

  /**
   * Get CSS for card styling
   */
  static getStyles() {
    return `
      .cfg-card {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px;
        margin-bottom: 8px;
        background: var(--cfg-bg-secondary, #2a2a2a);
        border: 1px solid var(--cfg-border, #444);
        border-radius: 4px;
        transition: all 0.2s;
      }

      .cfg-card:hover {
        background: var(--cfg-bg-tertiary, #333);
      }

      .cfg-card--selected {
        background: rgba(74, 144, 226, 0.2);
        border-color: var(--cfg-accent, #4a90e2);
      }

      .cfg-card__content {
        flex: 1;
        min-width: 0;
      }

      .cfg-card__title {
        font-weight: bold;
        color: var(--cfg-text-primary, #e0e0e0);
        font-size: 13px;
        margin-bottom: 4px;
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }

      .cfg-card__subtitle {
        font-size: 11px;
        color: var(--cfg-text-secondary, #aaa);
        line-height: 1.4;
      }

      .cfg-card__actions {
        display: flex;
        gap: 4px;
        flex-shrink: 0;
      }
    `
  }
}
