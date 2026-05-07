/**
 * Plugin connection state — observable singleton tracking the last-known
 * reachability of the CFG endpoint (#699 / epic #419).
 *
 * Written by `fetchCfg` after every call. Read by the connection banner and
 * any other surface that wants to gracefully degrade when CFG is unreachable.
 *
 * Status values:
 *   'unknown'      — no call has been made yet (initial state)
 *   'online'       — last call returned a 2xx response
 *   'offline'      — last call hit a network error / DNS fail / timeout
 *   'auth-failed'  — last call returned 401/403 (key revoked or wrong scope)
 *   'server-error' — last call returned 5xx
 *   'client-error' — last call returned a non-401/403 4xx
 *
 * The banner only surfaces `offline`. The other failure modes are noisy but
 * not infrastructure-level — leaving them silent here keeps the Foundry UI
 * uncluttered while still letting callers branch on the specific reason.
 */

'use strict'

/**
 * @typedef {'unknown'|'online'|'offline'|'auth-failed'|'server-error'|'client-error'} ConnectionStatus
 *
 * @typedef {Object} ConnectionState
 * @property {ConnectionStatus} status
 * @property {number|null} lastUpdated  — epoch ms of the last status write, or null
 * @property {number|null} lastStatusCode — HTTP status from the last call, or null
 */

/** @type {ConnectionState} */
const state = {
  status: 'unknown',
  lastUpdated: null,
  lastStatusCode: null,
}

/** @type {Set<(s: ConnectionState) => void>} */
const listeners = new Set()

/**
 * Snapshot of the current connection state. Always returns a new object so
 * callers can compare references between snapshots.
 *
 * @returns {ConnectionState}
 */
export function getConnectionState() {
  return { ...state }
}

/**
 * Subscribe to connection-state changes. Returns the unsubscribe function.
 * Listener exceptions are caught and logged so a misbehaving subscriber can't
 * brick the rest of the plugin.
 *
 * @param {(s: ConnectionState) => void} fn
 * @returns {() => void}
 */
export function onConnectionStateChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Update the connection state. Called by `fetchCfg`; not part of the public
 * API but exported for tests + the host-context auto-link path.
 *
 * @param {ConnectionStatus} status
 * @param {number|null} [statusCode]
 */
export function setConnectionStatus(status, statusCode = null) {
  if (state.status === status && state.lastStatusCode === statusCode) {
    // No-op: avoid unnecessary listener fanout when the state doesn't change.
    state.lastUpdated = Date.now()
    return
  }
  state.status = status
  state.lastStatusCode = statusCode
  state.lastUpdated = Date.now()
  for (const fn of listeners) {
    try {
      fn({ ...state })
    } catch (err) {
      console.warn('CFG Core | connection-state listener threw:', err)
    }
  }
}

/**
 * Reset state — tests only.
 * @internal
 */
export function __resetForTests() {
  state.status = 'unknown'
  state.lastUpdated = null
  state.lastStatusCode = null
  listeners.clear()
}
