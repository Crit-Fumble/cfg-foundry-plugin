/**
 * DOM Helper Utilities
 * Safe DOM manipulation methods to prevent XSS vulnerabilities
 */

/**
 * Safely create an element with text and optional icon
 * Prevents XSS by using textContent instead of innerHTML
 *
 * @param {string} tag - HTML tag name (e.g., 'div', 'span', 'p')
 * @param {string} text - Text content (will be escaped)
 * @param {object} options - Optional configuration
 * @param {string} options.icon - Font Awesome icon class (e.g., 'fas fa-dice-d20')
 * @param {string} options.className - CSS class name(s)
 * @param {object} options.attributes - HTML attributes to set
 * @param {object} options.dataset - Data attributes to set
 * @returns {HTMLElement} Created element
 *
 * @example
 * const el = createElementWithText('div', 'Campaign Name', {
 *   icon: 'fas fa-dice-d20',
 *   className: 'campaign-name',
 *   attributes: { id: 'campaign-1' }
 * });
 */
export function createElementWithText(tag, text, options = {}) {
  const element = document.createElement(tag)

  // Add icon first (if provided)
  if (options.icon) {
    const icon = document.createElement('i')
    icon.className = options.icon
    element.appendChild(icon)

    // Add space after icon if there's text
    if (text) {
      element.appendChild(document.createTextNode(' '))
    }
  }

  // Add text content (safely escaped)
  if (text) {
    element.appendChild(document.createTextNode(text))
  }

  // Add CSS classes
  if (options.className) {
    element.className = options.className
  }

  // Set attributes
  if (options.attributes) {
    Object.entries(options.attributes).forEach(([key, value]) => {
      element.setAttribute(key, value)
    })
  }

  // Set data attributes
  if (options.dataset) {
    Object.entries(options.dataset).forEach(([key, value]) => {
      element.dataset[key] = value
    })
  }

  return element
}

/**
 * Safely set element content with icon and text
 * Clears existing content and rebuilds safely
 *
 * @param {HTMLElement} element - Target element
 * @param {string} text - Text content (will be escaped)
 * @param {object} options - Optional configuration
 * @param {string} options.icon - Font Awesome icon class
 * @returns {HTMLElement} The modified element
 *
 * @example
 * setElementContent(nameRow, campaign.name, { icon: 'fas fa-dice-d20' });
 */
export function setElementContent(element, text, options = {}) {
  // Clear existing content
  element.textContent = ''

  // Add icon first (if provided)
  if (options.icon) {
    const icon = document.createElement('i')
    icon.className = options.icon
    element.appendChild(icon)

    // Add space after icon if there's text
    if (text) {
      element.appendChild(document.createTextNode(' '))
    }
  }

  // Add text content (safely escaped)
  if (text) {
    element.appendChild(document.createTextNode(text))
  }

  return element
}

/**
 * Create a button with icon and text
 *
 * @param {string} text - Button text
 * @param {object} options - Configuration
 * @param {string} options.icon - Font Awesome icon class
 * @param {string} options.className - CSS class name(s)
 * @param {Function} options.onClick - Click handler
 * @param {object} options.attributes - HTML attributes
 * @returns {HTMLButtonElement} Created button
 *
 * @example
 * const btn = createButton('Sync Now', {
 *   icon: 'fas fa-sync',
 *   className: 'sync-button',
 *   onClick: () => syncCampaign()
 * });
 */
export function createButton(text, options = {}) {
  const button = document.createElement('button')
  button.type = 'button'

  // Add icon first (if provided)
  if (options.icon) {
    const icon = document.createElement('i')
    icon.className = options.icon
    button.appendChild(icon)

    // Add space after icon if there's text
    if (text) {
      button.appendChild(document.createTextNode(' '))
    }
  }

  // Add text content (safely escaped)
  if (text) {
    button.appendChild(document.createTextNode(text))
  }

  // Add CSS classes
  if (options.className) {
    button.className = options.className
  }

  // Set attributes
  if (options.attributes) {
    Object.entries(options.attributes).forEach(([key, value]) => {
      button.setAttribute(key, value)
    })
  }

  // Add click handler
  if (options.onClick) {
    button.addEventListener('click', options.onClick)
  }

  return button
}

/**
 * Sanitize HTML string (basic sanitization - removes scripts)
 * WARNING: This is a basic sanitizer. For complex HTML, use DOMPurify or similar.
 *
 * @param {string} html - HTML string to sanitize
 * @returns {string} Sanitized HTML
 */
export function sanitizeHTML(html) {
  if (!html) return ''

  // Create a temporary div
  const temp = document.createElement('div')
  temp.textContent = html // This escapes all HTML

  return temp.innerHTML
}

/**
 * Create a link element safely
 *
 * @param {string} href - URL
 * @param {string} text - Link text
 * @param {object} options - Configuration
 * @param {string} options.icon - Font Awesome icon class
 * @param {string} options.className - CSS class name(s)
 * @param {boolean} options.newTab - Open in new tab (default: false)
 * @returns {HTMLAnchorElement} Created link
 */
export function createLink(href, text, options = {}) {
  const link = document.createElement('a')
  link.href = href

  // Add icon first (if provided)
  if (options.icon) {
    const icon = document.createElement('i')
    icon.className = options.icon
    link.appendChild(icon)

    // Add space after icon if there's text
    if (text) {
      link.appendChild(document.createTextNode(' '))
    }
  }

  // Add text content (safely escaped)
  if (text) {
    link.appendChild(document.createTextNode(text))
  }

  // Add CSS classes
  if (options.className) {
    link.className = options.className
  }

  // Open in new tab
  if (options.newTab) {
    link.target = '_blank'
    link.rel = 'noopener noreferrer' // Security best practice
  }

  return link
}

/**
 * Append multiple children to a parent element
 *
 * @param {HTMLElement} parent - Parent element
 * @param {...HTMLElement} children - Child elements to append
 * @returns {HTMLElement} The parent element
 */
export function appendChildren(parent, ...children) {
  children.forEach((child) => {
    if (child) {
      parent.appendChild(child)
    }
  })
  return parent
}

/**
 * Format a time ago string (e.g., "2 hours ago")
 * Returns a safe text node, not HTML
 *
 * @param {string|Date} timestamp - Timestamp to format
 * @returns {string} Formatted time string
 */
export function formatTimeAgo(timestamp) {
  if (!timestamp) return 'Never'

  const date = new Date(timestamp)
  const now = new Date()
  const seconds = Math.floor((now - date) / 1000)

  if (seconds < 60) return 'Just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} days ago`

  return date.toLocaleDateString()
}
