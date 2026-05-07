/**
 * Host-environment detection — Phase 0 of the multi-host plugin (#699 / epic #419).
 *
 * Distinguishes a Foundry container that the platform is hosting itself
 * ("cfg-hosted") from one running on the user's own server or a third-party
 * provider ("self-hosted"). The discriminator is a window-global injected by
 * the VTT proxy when it serves Foundry through `/vtt/*`:
 *
 *   window.__CFG_HOSTED_CONTEXT__ = {
 *     endpoint:       'https://core.crit-fumble.com', // CFG endpoint URL
 *     apiKey:         'cfk_…',                        // pre-minted server key
 *     installationId: '<cuid>',                       // Foundry-instance row
 *     cfgUserId:      '<cuid>',                       // owner of the container
 *   }
 *
 * Contract for the proxy injection (server-side, separate follow-up):
 *   - The proxy MUST inject this object before any Foundry script tag runs,
 *     so `Hooks.once('init')` sees it on its first read.
 *   - All four fields are required; partial contexts are rejected and the
 *     plugin falls back to the self-hosted pair flow.
 *   - The apiKey is server-minted with the same scope as a user-paired key;
 *     the plugin treats it identically once stored.
 *
 * Detection is one-shot — the global is captured into module state on the
 * first read so a tampered global later in the page lifecycle can't downgrade
 * the host kind.
 */

'use strict'

const MODULE_ID = 'crit-fumble-core'

/**
 * @typedef {Object} HostedContext
 * @property {string} endpoint
 * @property {string} apiKey
 * @property {string} installationId
 * @property {string} cfgUserId
 *
 * @typedef {'cfg-hosted'|'self-hosted'} HostKind
 */

/** @type {HostedContext|null} */
let _cachedContext = null
/** @type {HostKind|null} */
let _cachedKind = null
/** @type {boolean} */
let _hasReadGlobal = false

/**
 * Read the injected context once. Subsequent calls return the cached value.
 *
 * @returns {HostedContext|null}
 */
export function getHostedContext() {
  if (_hasReadGlobal) return _cachedContext
  _hasReadGlobal = true

  let raw
  try {
    raw = typeof window !== 'undefined' ? window.__CFG_HOSTED_CONTEXT__ : null
  } catch {
    raw = null
  }
  _cachedContext = _normalize(raw)
  _cachedKind = _cachedContext ? 'cfg-hosted' : 'self-hosted'
  return _cachedContext
}

/**
 * Returns 'cfg-hosted' when the injected global is present and well-formed,
 * 'self-hosted' otherwise. The host kind is the discriminator the rest of the
 * plugin (settings menu, pair flow, banner) branches on.
 *
 * @returns {HostKind}
 */
export function getHostKind() {
  if (_cachedKind) return _cachedKind
  // Force a one-shot read.
  getHostedContext()
  return _cachedKind ?? 'self-hosted'
}

/**
 * Apply the injected context to Foundry settings — populates `coreApiUrl` +
 * `apiKey` + `installationId` from the global. No-op when self-hosted.
 *
 * Idempotent: the values are only written when they differ from the existing
 * settings, so a settings.set during init doesn't fire spurious change hooks.
 *
 * @returns {Promise<HostKind>}
 */
export async function applyHostedContext() {
  const ctx = getHostedContext()
  if (!ctx) return 'self-hosted'

  await _setIfChanged('coreApiUrl', ctx.endpoint)
  await _setIfChanged('apiKey', ctx.apiKey)
  await _setIfChanged('installationId', ctx.installationId)
  return 'cfg-hosted'
}

/**
 * Reset module state — tests only.
 * @internal
 */
export function __resetForTests() {
  _cachedContext = null
  _cachedKind = null
  _hasReadGlobal = false
}

function _normalize(raw) {
  if (!raw || typeof raw !== 'object') return null
  const { endpoint, apiKey, installationId, cfgUserId } = raw
  if (!_isNonEmptyString(endpoint)) return null
  if (!_isNonEmptyString(apiKey)) return null
  if (!_isNonEmptyString(installationId)) return null
  if (!_isNonEmptyString(cfgUserId)) return null
  return {
    endpoint: endpoint.replace(/\/$/, ''),
    apiKey,
    installationId,
    cfgUserId,
  }
}

function _isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

async function _setIfChanged(key, value) {
  let current
  try {
    current = game.settings.get(MODULE_ID, key)
  } catch {
    current = undefined
  }
  if (current === value) return
  try {
    await game.settings.set(MODULE_ID, key, value)
  } catch (err) {
    console.warn(`CFG Core | applyHostedContext: failed to write ${key}:`, err?.message || err)
  }
}
