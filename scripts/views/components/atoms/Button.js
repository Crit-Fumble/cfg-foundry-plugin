/**
 * Button Atom
 * Reusable button component with consistent styling
 */

export class Button {
  /**
   * Create a button element
   * @param {Object} options - Button options
   * @param {string} options.label - Button text
   * @param {string} options.icon - Font Awesome icon class (e.g., 'fa-check')
   * @param {string} options.variant - Button style: 'primary', 'secondary', 'danger', 'success'
   * @param {boolean} options.disabled - Whether button is disabled
   * @param {Function} options.onClick - Click handler
   * @param {Object} options.dataset - Data attributes (data-action, data-id, etc.)
   * @returns {HTMLElement}
   */
  static create(options = {}) {
    const {
      label = 'Button',
      icon = null,
      variant = 'primary',
      disabled = false,
      onClick = null,
      dataset = {},
    } = options

    const button = document.createElement('button')
    button.type = 'button'
    button.className = `cfg-button cfg-button--${variant}`
    button.disabled = disabled

    // Add icon if provided
    if (icon) {
      const iconEl = document.createElement('i')
      iconEl.className = `fas ${icon}`
      button.appendChild(iconEl)

      if (label) {
        button.appendChild(document.createTextNode(' ' + label))
      }
    } else {
      button.textContent = label
    }

    // Add data attributes
    Object.entries(dataset).forEach(([key, value]) => {
      button.dataset[key] = value
    })

    // Add click handler
    if (onClick) {
      button.addEventListener('click', onClick)
    }

    return button
  }

  /**
   * Get CSS for button styling
   */
  static getStyles() {
    return `
      .cfg-button {
        padding: 10px 16px;
        border: none;
        border-radius: 3px;
        cursor: pointer;
        font-size: 13px;
        font-weight: bold;
        transition: background 0.2s, opacity 0.2s;
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }

      .cfg-button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .cfg-button--primary {
        background: var(--cfg-accent, #4a90e2);
        color: white;
      }

      .cfg-button--primary:hover:not(:disabled) {
        background: var(--cfg-accent-hover, #357abd);
      }

      .cfg-button--secondary {
        background: var(--cfg-bg-tertiary, #555);
        color: var(--cfg-text-primary, #e0e0e0);
        border: 1px solid var(--cfg-border, #666);
      }

      .cfg-button--secondary:hover:not(:disabled) {
        filter: brightness(1.2);
      }

      .cfg-button--success {
        background: #4caf50;
        color: white;
      }

      .cfg-button--success:hover:not(:disabled) {
        background: #45a049;
      }

      .cfg-button--danger {
        background: rgba(255, 107, 107, 0.2);
        color: #ff6b6b;
        border: 1px solid #ff6b6b;
      }

      .cfg-button--danger:hover:not(:disabled) {
        background: rgba(255, 107, 107, 0.3);
      }

      .cfg-button i {
        font-size: 14px;
      }
    `
  }
}
