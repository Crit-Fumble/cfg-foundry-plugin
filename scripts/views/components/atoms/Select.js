/**
 * Select Atom
 * Reusable select dropdown component
 */

export class Select {
  /**
   * Create a select element
   * @param {Object} options - Select options
   * @param {Array} options.options - Array of {value, label, selected} objects
   * @param {boolean} options.disabled - Whether select is disabled
   * @param {string} options.placeholder - Placeholder option text
   * @param {Function} options.onChange - Change handler
   * @param {Object} options.dataset - Data attributes
   * @returns {HTMLElement}
   */
  static create(options = {}) {
    const { options: selectOptions = [], disabled = false, placeholder = null, onChange = null, dataset = {} } = options

    const select = document.createElement('select')
    select.className = 'cfg-select'
    select.disabled = disabled

    // Add placeholder option
    if (placeholder) {
      const placeholderOption = document.createElement('option')
      placeholderOption.value = ''
      placeholderOption.textContent = placeholder
      placeholderOption.disabled = true
      placeholderOption.selected = true
      select.appendChild(placeholderOption)
    }

    // Add options
    selectOptions.forEach((opt) => {
      const option = document.createElement('option')
      option.value = opt.value
      option.textContent = opt.label
      if (opt.selected) {
        option.selected = true
      }
      select.appendChild(option)
    })

    // Add data attributes
    Object.entries(dataset).forEach(([key, value]) => {
      select.dataset[key] = value
    })

    // Add change handler
    if (onChange) {
      select.addEventListener('change', onChange)
    }

    return select
  }

  /**
   * Get CSS for select styling
   */
  static getStyles() {
    return `
      .cfg-select {
        width: 100%;
        padding: 8px;
        background: var(--cfg-bg-tertiary, #333);
        border: 1px solid var(--cfg-border, #444);
        border-radius: 3px;
        color: var(--cfg-text-primary, #e0e0e0);
        font-size: 13px;
        cursor: pointer;
      }

      .cfg-select:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .cfg-select:focus {
        outline: none;
        border-color: var(--cfg-accent, #4a90e2);
      }
    `
  }
}
