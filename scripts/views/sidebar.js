/**
 * CFG Core sidebar — collapsible side panel rendered inside FoundryVTT.
 *
 * Adds a thin 32px rail to the right edge of the Foundry viewport. Clicking
 * the rail expands it to a 320px sidebar containing an iframe that loads
 * /foundry/sidebar on the configured Core API URL. The iframe renders the
 * unified Shell (variant="foundry") with the user's pinned-app dock, so
 * Foundry players see the same CFG dock they get on Desktop and in the
 * Discord Activity.
 *
 * Why an iframe: the Shell primitive is a React component tree with provider
 * dependencies (WindowManager, dock-preferences hooks, auth-fetch). Bundling
 * React into the Foundry plugin would bloat the module download for every
 * user, so we reuse the web build that already runs at core.crit-fumble.com
 * and render it in an iframe. Bundle impact on the plugin itself is ~2KB
 * of JS + a sprinkle of CSS.
 *
 * Collapsed / expanded state persists in localStorage so the sidebar opens
 * in whatever mode the user left it in.
 */

const MODULE_ID = 'crit-fumble-core'
const STORAGE_KEY = 'cfg-foundry-sidebar:collapsed'
const SIDEBAR_ID = 'cfg-core-sidebar'

/**
 * Mount the sidebar into document.body. Idempotent — calling twice is a no-op.
 *
 * @param {object} opts
 * @param {string} opts.coreUrl  Base URL of the Core platform (without trailing slash).
 * @param {string|null} opts.token  Optional Bearer token for self-hosted Foundry.
 *   Passed to the iframe as `?token=` so AuthHeaderProvider picks it up.
 */
export function mountCFGSidebar({ coreUrl, token }) {
  if (typeof document === 'undefined') return
  if (document.getElementById(SIDEBAR_ID)) return

  const sidebar = document.createElement('aside')
  sidebar.id = SIDEBAR_ID
  sidebar.setAttribute('aria-label', 'Crit-Fumble sidebar')
  sidebar.dataset.collapsed = _loadCollapsed() ? 'true' : 'false'

  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'cfg-sidebar-toggle'
  toggle.setAttribute('aria-label', 'Toggle Crit-Fumble sidebar')
  toggle.innerHTML = '<span aria-hidden="true">CFG</span>'
  toggle.addEventListener('click', () => {
    const next = sidebar.dataset.collapsed !== 'true'
    sidebar.dataset.collapsed = next ? 'true' : 'false'
    _saveCollapsed(next)
  })

  const iframeWrap = document.createElement('div')
  iframeWrap.className = 'cfg-sidebar-frame'

  const iframe = document.createElement('iframe')
  const iframeUrl = _buildIframeUrl(coreUrl, token)
  iframe.src = iframeUrl
  iframe.title = 'Crit-Fumble'
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups')
  iframe.setAttribute('loading', 'lazy')
  iframeWrap.appendChild(iframe)

  sidebar.appendChild(toggle)
  sidebar.appendChild(iframeWrap)
  document.body.appendChild(sidebar)
}

/**
 * Remove the sidebar from the DOM. Safe to call when it wasn't mounted.
 */
export function unmountCFGSidebar() {
  const existing = document.getElementById(SIDEBAR_ID)
  if (existing) existing.remove()
}

function _buildIframeUrl(coreUrl, token) {
  const url = new URL('/foundry/sidebar', coreUrl)
  if (token) url.searchParams.set('token', token)
  return url.toString()
}

function _loadCollapsed() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return true // collapsed by default on first run
    return raw === 'true'
  } catch {
    return true
  }
}

function _saveCollapsed(collapsed) {
  try {
    window.localStorage.setItem(STORAGE_KEY, collapsed ? 'true' : 'false')
  } catch {
    /* localStorage disabled — non-fatal */
  }
}

/**
 * Exposed for tests — not part of the public API of the plugin.
 */
export const __internals = { MODULE_ID, STORAGE_KEY, SIDEBAR_ID, _buildIframeUrl }
