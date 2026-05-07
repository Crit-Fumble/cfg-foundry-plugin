/**
 * Connection banner — surface for the offline state tracked by
 * `connection-state.js` (#699 / epic #419).
 *
 * A small fixed-position pill that appears in the lower-left corner of the
 * Foundry viewport whenever the last `fetchCfg` call hit the offline branch.
 * Purely informational: it does not block any Foundry interaction, and it
 * disappears as soon as a subsequent CFG call succeeds.
 *
 * Mounted once from `Hooks.once('ready')` alongside the sidebar, so every
 * authenticated CFG widget shares the same banner instance.
 */

'use strict'

import { getConnectionState, onConnectionStateChange } from '../auth/connection-state.js'

const BANNER_ID = 'cfg-core-connection-banner'

/**
 * Mount the banner element. Idempotent — calling twice is a no-op.
 *
 * @returns {{ unmount: () => void }}
 */
export function mountConnectionBanner() {
  if (typeof document === 'undefined') {
    return { unmount: () => {} }
  }
  if (document.getElementById(BANNER_ID)) {
    return { unmount: unmountConnectionBanner }
  }

  const el = document.createElement('div')
  el.id = BANNER_ID
  el.setAttribute('role', 'status')
  el.setAttribute('aria-live', 'polite')
  el.dataset.visible = 'false'
  el.style.cssText = [
    'position: fixed',
    'left: 12px',
    'bottom: 12px',
    'z-index: 99',
    'display: none',
    'padding: 6px 12px',
    'border-radius: 4px',
    'background: rgba(120, 30, 30, 0.92)',
    'color: #fff',
    'font-size: 12px',
    'font-family: var(--font-primary, sans-serif)',
    'box-shadow: 0 2px 4px rgba(0,0,0,0.3)',
    'pointer-events: none',
  ].join(';')
  el.textContent = 'Crit-Fumble offline — features unavailable'

  document.body.appendChild(el)
  _refresh(el, getConnectionState())
  const unsubscribe = onConnectionStateChange((state) => _refresh(el, state))

  return {
    unmount: () => {
      unsubscribe()
      unmountConnectionBanner()
    },
  }
}

/**
 * Remove the banner from the DOM. Safe to call when nothing was mounted.
 */
export function unmountConnectionBanner() {
  if (typeof document === 'undefined') return
  const existing = document.getElementById(BANNER_ID)
  if (existing && typeof existing.remove === 'function') existing.remove()
}

function _refresh(el, state) {
  const visible = state?.status === 'offline'
  el.dataset.visible = visible ? 'true' : 'false'
  el.style.display = visible ? 'block' : 'none'
}

/**
 * Exposed for tests — not part of the public banner API.
 * @internal
 */
export const __internals = { BANNER_ID, _refresh }
