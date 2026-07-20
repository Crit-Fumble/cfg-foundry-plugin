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
 * URL-path fallback (#699 follow-up): the `__CFG_HOSTED_CONTEXT__` injection
 * is not yet implemented on the proxy. Until it lands, the only signal a
 * CFG-hosted container reliably emits is its route shape: the VTT proxy serves
 * every hosted Foundry from `/servers/foundryvtt/<installationId>/...`. A world
 * created via Foundry's OWN setup UI (not the CFG create-world flow) has no
 * injected global and no stored apiKey, yet it is still cfg-hosted by virtue of
 * the route it's served on. We therefore treat that path prefix as a
 * cfg-hosted signal too — without it, such worlds wrongly fall through to the
 * self-hosted pair prompt. Self-hosted / third-party Foundry never serves on
 * this prefix, so the fallback can't misclassify a BYO instance.
 *
 * `getHostedContext()` (the auto-link auth payload) still requires the full
 * injected global — the path alone can't mint an apiKey. Only `getHostKind()`
 * honours the path fallback, which is exactly what gates the first-run prompt
 * and the link-settings buttons.
 *
 * Detection is one-shot — the kind is captured into module state on the first
 * read so a tampered global (or a later history.pushState) can't downgrade it.
 */

'use strict'

const MODULE_ID = 'crit-fumble-core'

/**
 * Route prefix the VTT proxy serves every cfg-hosted Foundry container under.
 * `/servers/foundryvtt/<installationId>/...` is the one URL shape for all
 * hosted installs — see cfg-core-server `routes/vtt-proxy.ts`.
 */
const CFG_HOSTED_PATH_PREFIX = '/servers/foundryvtt/'

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
 * `true` when the current page is served under the cfg-hosted proxy route
 * (`/servers/foundryvtt/<installationId>/...`). This is the URL-path fallback
 * that classifies a hosted container even when the proxy hasn't injected
 * `__CFG_HOSTED_CONTEXT__` (the common case today — see module header).
 *
 * @returns {boolean}
 */
function _isCfgHostedPath() {
  try {
    if (typeof window === 'undefined') return false
    return Boolean(window.location?.pathname?.startsWith(CFG_HOSTED_PATH_PREFIX))
  } catch {
    return false
  }
}

/**
 * Read the injected context once. Subsequent calls return the cached value.
 *
 * Note: the host *kind* may be 'cfg-hosted' (via the URL-path fallback) while
 * this returns null — the path proves the container is hosted, but only the
 * injected global carries the auth payload needed to auto-link. Callers that
 * need the apiKey must null-check; callers that only need the kind use
 * `getHostKind()`.
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
  // cfg-hosted when EITHER a well-formed global is injected OR the page is
  // served on the hosted proxy route. The path fallback covers worlds created
  // via Foundry's own setup UI (no global, no stored key) that are still
  // running inside a CFG container.
  _cachedKind = _cachedContext || _isCfgHostedPath() ? 'cfg-hosted' : 'self-hosted'
  return _cachedContext
}

/**
 * Returns 'cfg-hosted' when the injected global is present and well-formed,
 * OR when the page is served under the cfg-hosted proxy route
 * (`/servers/foundryvtt/<installationId>/...`); 'self-hosted' otherwise. The
 * host kind is the discriminator the rest of the plugin (first-run prompt,
 * settings menu, pair flow, banner) branches on.
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
  // 1. Legacy path: an injected `__CFG_HOSTED_CONTEXT__` global wins if present.
  const injected = getHostedContext()
  if (injected) {
    await _setIfChanged('coreApiUrl', injected.endpoint)
    await _setIfChanged('apiKey', injected.apiKey)
    await _setIfChanged('installationId', injected.installationId)
    return 'cfg-hosted'
  }

  // 2. Programmatic pairing: cfg-hosted Foundry is served same-origin under
  //    `/servers/foundryvtt/<installationId>/…`, so fetch the installation's
  //    host key from core with the browser's session cookie. The endpoint is
  //    OWNER-scoped — the owner's plugin gets a `cfk_…` key it uses as a Bearer
  //    token so the status/activity heartbeats authenticate AS the installation
  //    (no longer piggybacking on whichever user's session is connected). A
  //    non-owner GM gets no key and stays on same-origin session-cookie auth.
  const installationId = _installationIdFromPath()
  if (!installationId) return 'self-hosted'

  const origin = _originOrNull()
  if (!origin) return 'cfg-hosted'
  try {
    const res = await fetch(
      `${origin}/api/v1/account/foundry/hosted-context?installationId=${encodeURIComponent(installationId)}`,
      { method: 'GET', headers: { accept: 'application/json' }, credentials: 'include' },
    )
    if (res.ok) {
      const ctx = await res.json()
      if (ctx && _isNonEmptyString(ctx.apiKey)) {
        await _setIfChanged('coreApiUrl', ctx.endpoint || origin)
        await _setIfChanged('apiKey', ctx.apiKey)
        await _setIfChanged('installationId', ctx.installationId || installationId)
        return 'cfg-hosted'
      }
    }
  } catch (err) {
    console.warn('CFG Core | hosted-context fetch failed (non-fatal):', err?.message || err)
  }
  // No key (non-owner GM, or a transient failure): CLEAR any stale Bearer key so
  // the plugin falls back to same-origin session-cookie auth instead of sending
  // a dead token. installationId/coreApiUrl are set by the ready-hook auto-correct.
  await _setIfChanged('apiKey', '')
  return 'cfg-hosted'
}

/**
 * The installation this world belongs to, id or slug, or null when unknowable.
 *
 * Prefers the injected global, falls back to the hosted route path. The fallback is the case
 * that matters: a world created through Foundry's own setup UI has no injected context, so
 * `getHostedContext()` is null while the world is still very much cfg-hosted — which is why
 * `getHostKind()` has the same path fallback. Callers that need to NAME the installation to the
 * server (module sync, dt#211) must use this rather than reaching into the context, or they get
 * null in exactly the situation they were written for.
 *
 * Slug is fine on the wire: the server resolves id or slug.
 */
export function getInstallationRef() {
  return getHostedContext()?.installationId || _installationIdFromPath()
}

/** Installation id (or slug) from the cfg-hosted route path, or null. */
function _installationIdFromPath() {
  try {
    if (typeof window === 'undefined') return null
    const m = window.location?.pathname?.match(/^\/servers\/foundryvtt\/([^/]+)/)
    return m?.[1] || null
  } catch {
    return null
  }
}

/** Same-origin base for the hosted-context fetch, or null when unavailable. */
function _originOrNull() {
  try {
    return typeof window !== 'undefined' ? window.location?.origin || null : null
  } catch {
    return null
  }
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
