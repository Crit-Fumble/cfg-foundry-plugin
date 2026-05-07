/**
 * Avatar Atom
 * Image avatar component
 */

export class Avatar {
  /**
   * Create an avatar element
   * @param {Object} options - Avatar options
   * @param {string} options.src - Image source URL
   * @param {string} options.alt - Alt text
   * @param {string} options.size - Size: 'small' (32px), 'medium' (40px), 'large' (64px)
   * @param {string} options.shape - Shape: 'circle', 'square', 'rounded'
   * @param {string} options.fallbackIcon - Font Awesome icon for fallback
   * @returns {HTMLElement}
   */
  static create(options = {}) {
    const { src = '', alt = '', size = 'medium', shape = 'rounded', fallbackIcon = 'fa-user' } = options

    const avatar = document.createElement('div')
    avatar.className = `cfg-avatar cfg-avatar--${size} cfg-avatar--${shape}`

    if (src) {
      const img = document.createElement('img')
      img.src = src
      img.alt = alt
      img.onerror = () => {
        // Replace with fallback icon on error
        img.remove()
        const icon = document.createElement('i')
        icon.className = `fas ${fallbackIcon}`
        avatar.appendChild(icon)
      }
      avatar.appendChild(img)
    } else {
      const icon = document.createElement('i')
      icon.className = `fas ${fallbackIcon}`
      avatar.appendChild(icon)
    }

    return avatar
  }

  /**
   * Get CSS for avatar styling
   */
  static getStyles() {
    return `
      .cfg-avatar {
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        background: var(--cfg-bg-tertiary, #333);
        border: 2px solid var(--cfg-border, #444);
        flex-shrink: 0;
      }

      .cfg-avatar--small {
        width: 32px;
        height: 32px;
      }

      .cfg-avatar--medium {
        width: 40px;
        height: 40px;
      }

      .cfg-avatar--large {
        width: 64px;
        height: 64px;
      }

      .cfg-avatar--circle {
        border-radius: 50%;
      }

      .cfg-avatar--rounded {
        border-radius: 4px;
      }

      .cfg-avatar--square {
        border-radius: 0;
      }

      .cfg-avatar img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      .cfg-avatar i {
        font-size: 18px;
        color: var(--cfg-text-secondary, #aaa);
      }

      .cfg-avatar--small i {
        font-size: 14px;
      }

      .cfg-avatar--large i {
        font-size: 32px;
      }
    `
  }
}
