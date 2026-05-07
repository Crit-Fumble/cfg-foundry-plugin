/**
 * Badge Atom
 * Status badge component
 */

export class Badge {
  /**
   * Create a badge element
   * @param {Object} options - Badge options
   * @param {string} options.label - Badge text
   * @param {string} options.icon - Font Awesome icon class
   * @param {string} options.variant - Badge style: 'success', 'info', 'warning', 'danger'
   * @returns {HTMLElement}
   */
  static create(options = {}) {
    const { label = '', icon = null, variant = 'info' } = options

    const badge = document.createElement('span')
    badge.className = `cfg-badge cfg-badge--${variant}`

    if (icon) {
      const iconEl = document.createElement('i')
      iconEl.className = `fas ${icon}`
      badge.appendChild(iconEl)

      if (label) {
        badge.appendChild(document.createTextNode(' ' + label))
      }
    } else {
      badge.textContent = label
    }

    return badge
  }

  /**
   * Get CSS for badge styling
   */
  static getStyles() {
    return `
      .cfg-badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 8px;
        border-radius: 3px;
        font-size: 10px;
        font-weight: bold;
      }

      .cfg-badge--success {
        background: rgba(76, 175, 80, 0.2);
        border: 1px solid #4caf50;
        color: #4caf50;
      }

      .cfg-badge--info {
        background: rgba(74, 144, 226, 0.2);
        border: 1px solid var(--cfg-accent, #4a90e2);
        color: var(--cfg-accent, #4a90e2);
      }

      .cfg-badge--warning {
        background: rgba(255, 193, 7, 0.2);
        border: 1px solid #ffc107;
        color: #ffc107;
      }

      .cfg-badge--danger {
        background: rgba(255, 107, 107, 0.2);
        border: 1px solid #ff6b6b;
        color: #ff6b6b;
      }

      .cfg-badge i {
        font-size: 9px;
      }
    `
  }
}
