/**
 * Form Group Molecule
 * Label + input/select combination
 */

export class FormGroup {
  /**
   * Create a form group element
   * @param {Object} options - Form group options
   * @param {string} options.label - Label text
   * @param {HTMLElement} options.input - Input/select element
   * @param {string} options.hint - Optional hint text
   * @param {boolean} options.required - Whether field is required
   * @returns {HTMLElement}
   */
  static create(options = {}) {
    const { label = '', input = null, hint = null, required = false } = options

    const group = document.createElement('div')
    group.className = 'cfg-form-group'

    // Create label
    const labelEl = document.createElement('label')
    labelEl.className = 'cfg-form-group__label'
    labelEl.textContent = label
    if (required) {
      const requiredSpan = document.createElement('span')
      requiredSpan.className = 'cfg-form-group__required'
      requiredSpan.textContent = ' *'
      labelEl.appendChild(requiredSpan)
    }
    group.appendChild(labelEl)

    // Add input
    if (input) {
      group.appendChild(input)
    }

    // Add hint
    if (hint) {
      const hintEl = document.createElement('p')
      hintEl.className = 'cfg-form-group__hint'
      hintEl.textContent = hint
      group.appendChild(hintEl)
    }

    return group
  }

  /**
   * Get CSS for form group styling
   */
  static getStyles() {
    return `
      .cfg-form-group {
        margin-bottom: 16px;
      }

      .cfg-form-group__label {
        display: block;
        font-weight: bold;
        margin-bottom: 6px;
        color: var(--cfg-text-primary, #e0e0e0);
        font-size: 13px;
      }

      .cfg-form-group__required {
        color: #ff6b6b;
      }

      .cfg-form-group__hint {
        margin: 6px 0 0 0;
        font-size: 11px;
        color: var(--cfg-text-muted, #999);
        font-style: italic;
      }

      .cfg-form-group__hint.warning {
        color: #ff6b6b;
        font-weight: bold;
      }
    `
  }
}
