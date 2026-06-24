/**
 * Crit-Fumble Pair Flow — multi-host plugin (#698 / epic #419)
 *
 * Drives the RFC 8628-style device-pair handshake against the existing
 * `/api/v1/public/pair` endpoint (TaleSpire reused). Plugin lifecycle:
 *
 *   1. POST /api/v1/public/pair        → { pairId, code, expiresAt }
 *   2. window.open(`/pair/{code}`)     → user confirms in their browser
 *   3. GET  /api/v1/public/pair/:pairId (poll)
 *   4. On `status: 'completed'`        → store apiKey in module settings
 *
 * The same `apiKey` + `coreApiUrl` settings power every authenticated CFG
 * call via `fetchCfg`. The flow is GM-only — non-GM users authenticate
 * via the same-origin session cookie when running cfg-hosted, or they
 * have no platform link at all on self-hosted (acceptable: their VTT
 * experience just doesn't include character sync, etc.).
 */

'use strict'

import { setConnectionStatus } from './connection-state.js'
import { getHostKind } from './host-context.js'

const MODULE_ID = 'crit-fumble-core'
const PAIR_PLATFORM = 'foundry'
const POLL_INTERVAL_MS = 3_000
const POLL_TIMEOUT_MS = 5 * 60 * 1000 // matches server PAIR_TTL_MS
const FETCH_TIMEOUT_MS = 20_000

/**
 * Read the configured CFG endpoint, sans trailing slash. Falls back to the
 * production origin when the setting is missing — keeps `fetchCfg` callable
 * even before settings are fully wired up.
 *
 * @returns {string}
 */
export function getCfgEndpoint() {
  let url = ''
  try {
    url = game.settings.get(MODULE_ID, 'coreApiUrl') || ''
  } catch {
    // settings not ready yet
  }
  return (url || 'https://core.crit-fumble.com').replace(/\/$/, '')
}

/**
 * Read the world-scoped API key minted by the pair flow.
 * @returns {string|null}
 */
export function getCfgApiKey() {
  try {
    return game.settings.get(MODULE_ID, 'apiKey') || null
  } catch {
    return null
  }
}

/**
 * Authenticated fetch helper — every plugin → CFG call goes through here.
 *
 * Safety:
 *   - Reads endpoint + apiKey from settings on each call so a freshly-paired
 *     key takes effect without reload.
 *   - The Authorization header is added internally; callers MUST NOT pass it.
 *     We strip any `authorization` from `init.headers` defensively so the key
 *     can't be overwritten with a stale value at the call site.
 *   - The key never appears in console output. The helper never throws —
 *     network/transport errors and HTTP failures are returned as a typed
 *     result so callers can branch without try/catch.
 *
 * Result shape:
 *   { ok: true,  status, data }                 — 2xx, body parsed (JSON or null)
 *   { ok: false, reason: 'offline', error }     — network/DNS/timeout
 *   { ok: false, reason: 'auth-failed', status }— 401/403 (re-pair required)
 *   { ok: false, reason: 'server-error', status, body } — 5xx
 *   { ok: false, reason: 'client-error', status, body } — non-401/403 4xx
 *
 * Side effects: every call updates `connection-state` so the offline banner
 * and other observers react to the latest reachability without polling.
 *
 * @param {string} path                  — leading slash, e.g. `/api/v1/account/user`
 * @param {RequestInit & {timeoutMs?: number}} [init]
 * @returns {Promise<{ok:true,status:number,data:any}|{ok:false,reason:string,status?:number,body?:any,error?:string}>}
 */
export async function fetchCfg(path, init = {}) {
  const endpoint = getCfgEndpoint()
  // cfg-hosted Foundry is served same-origin with core, so the same-origin
  // session cookie is the auth — never the (possibly-stale) pair-flow API key.
  // Reserve the Bearer key + the cookie-less `credentials: 'omit'` path for
  // genuinely self-hosted installs, whose Foundry origin ≠ CFG origin. (#43)
  const cfgHosted = getHostKind() === 'cfg-hosted'
  const apiKey = cfgHosted ? null : getCfgApiKey()

  const headers = new Headers(init.headers || {})
  // Strip caller-supplied auth — only this helper sets it.
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase() === 'authorization') headers.delete(name)
  }
  if (apiKey) headers.set('Authorization', `Bearer ${apiKey}`)
  if (init.body && !headers.has('content-type')) {
    headers.set('Content-Type', 'application/json')
  }

  const timeoutMs = init.timeoutMs ?? FETCH_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let response
  try {
    response = await fetch(`${endpoint}${path}`, {
      ...init,
      headers,
      // cfg-hosted: same-origin → send the session cookie (the auth). Self-hosted:
      // Foundry origin ≠ CFG origin, cookies aren't usable, the Bearer key is the
      // only auth — omit cookies so a foreign cookie can't ride along. (#43)
      credentials: cfgHosted ? 'include' : 'omit',
      signal: init.signal ?? controller.signal,
    })
  } catch (err) {
    // DNS failure, connection refused, abort/timeout, CORS preflight reject.
    // All look identical from the caller's perspective: the platform is not
    // reachable right now.
    setConnectionStatus('offline')
    return { ok: false, reason: 'offline', error: err?.message || 'Network error' }
  } finally {
    clearTimeout(timer)
  }

  const status = response.status
  if (response.ok) {
    let data = null
    try {
      data = await response.json()
    } catch {
      // Empty body or non-JSON success — treat as null data, still ok.
    }
    setConnectionStatus('online', status)
    return { ok: true, status, data }
  }

  const body = await _readBody(response)

  if (status === 401 || status === 403) {
    setConnectionStatus('auth-failed', status)
    return { ok: false, reason: 'auth-failed', status, body }
  }
  if (status >= 500) {
    setConnectionStatus('server-error', status)
    return { ok: false, reason: 'server-error', status, body }
  }
  setConnectionStatus('client-error', status)
  return { ok: false, reason: 'client-error', status, body }
}

async function _readBody(response) {
  try {
    const text = await response.text()
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  } catch {
    return null
  }
}

/**
 * Module-scoped pair-flow state. Only one flow can run at a time per Foundry
 * client; the UI guards against starting a second one while one is pending.
 *
 * @typedef {Object} PairState
 * @property {'idle'|'pending'|'completed'|'expired'|'error'} status
 * @property {string|null} pairId
 * @property {string|null} code
 * @property {string|null} expiresAt
 * @property {string|null} error
 */

/** @type {PairState} */
const state = {
  status: 'idle',
  pairId: null,
  code: null,
  expiresAt: null,
  error: null,
}

/** @type {ReturnType<typeof setTimeout>|null} */
let pollTimer = null
/** @type {ReturnType<typeof setTimeout>|null} */
let expiryTimer = null
/** @type {Set<(s: PairState) => void>} */
const listeners = new Set()

/** Snapshot of the current pair-flow state. */
export function getPairState() {
  return { ...state }
}

/**
 * Subscribe to pair-state changes. Returns the unsubscribe function.
 * @param {(s: PairState) => void} fn
 */
export function onPairStateChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function emit() {
  const snapshot = getPairState()
  for (const fn of listeners) {
    try {
      fn(snapshot)
    } catch (err) {
      console.warn('CFG Core | pair listener threw:', err)
    }
  }
}

function clearTimers() {
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
  if (expiryTimer) {
    clearTimeout(expiryTimer)
    expiryTimer = null
  }
}

function resetState(next = {}) {
  state.status = next.status ?? 'idle'
  state.pairId = next.pairId ?? null
  state.code = next.code ?? null
  state.expiresAt = next.expiresAt ?? null
  state.error = next.error ?? null
}

/**
 * `true` when the Foundry container has been linked to a CFG account via the
 * pair flow. Used by the settings UI to decide between Link / Unlink buttons.
 */
export function isLinked() {
  return Boolean(getCfgApiKey())
}

/**
 * Cancel an in-flight pair flow — called on user-initiated unlink, on
 * settings-window close, or on Hooks.once('closeGame'). Idempotent.
 */
export function cancelPairFlow() {
  clearTimers()
  if (state.status === 'pending') {
    resetState({ status: 'idle' })
    emit()
  }
}

/**
 * Start a pair flow.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.openWindow=true] — when false (tests), skip the
 *        `window.open` call. The popup is still opened by default in
 *        production so the user lands on `/pair/{code}` immediately.
 * @returns {Promise<PairState>} resolves once the flow reaches a terminal
 *        state (`completed` | `expired` | `error`). Rejects only on
 *        unexpected exceptions; expected failures land in `state.status`.
 */
export async function startPairFlow(opts = {}) {
  if (state.status === 'pending') {
    return getPairState()
  }

  cancelPairFlow()
  resetState({ status: 'pending' })
  emit()

  const endpoint = getCfgEndpoint()
  const body = {
    platform: PAIR_PLATFORM,
    foundryUrl: _readFoundryUrl(),
    foundryWorldId: _readFoundryWorldId(),
    foundryUserId: _readFoundryUserId(),
  }

  let res
  try {
    res = await fetch(`${endpoint}/api/v1/public/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify(body),
    })
  } catch (err) {
    resetState({ status: 'error', error: err?.message || 'Network error' })
    emit()
    return getPairState()
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const json = await res.json()
      if (json?.error) detail = json.error
    } catch {
      /* swallow */
    }
    resetState({ status: 'error', error: detail })
    emit()
    return getPairState()
  }

  let payload
  try {
    payload = await res.json()
  } catch {
    resetState({ status: 'error', error: 'Bad response from CFG' })
    emit()
    return getPairState()
  }

  if (!payload?.pairId || !payload?.code) {
    resetState({ status: 'error', error: 'Bad response from CFG' })
    emit()
    return getPairState()
  }

  state.pairId = payload.pairId
  state.code = payload.code
  state.expiresAt = payload.expiresAt || null
  emit()

  if (opts.openWindow !== false) {
    try {
      // The user-confirm page lives at /pair/{code}. Plain string interp
      // is intentional — the code is server-generated from a fixed alphabet.
      window.open(`${endpoint}/pair/${encodeURIComponent(payload.code)}`, '_blank', 'noopener,noreferrer')
    } catch (err) {
      console.warn('CFG Core | window.open blocked; user can copy the code instead:', err)
    }
  }

  // Hard stop at TTL — server expires after 5 min, we mirror that locally so
  // a network partition doesn't leave the UI spinning forever.
  expiryTimer = setTimeout(() => {
    if (state.status === 'pending') {
      clearTimers()
      resetState({ status: 'expired' })
      emit()
    }
  }, POLL_TIMEOUT_MS)

  await _scheduleNextPoll()
  return getPairState()
}

/**
 * Unlink — clears the stored API key + cancels any in-flight flow. Idempotent.
 * Server-side revocation happens on the next pair (existing key is revoked
 * before a new one mints — see pair.ts:273) or via Account → Integrations.
 */
export async function unlinkPair() {
  cancelPairFlow()
  try {
    await game.settings.set(MODULE_ID, 'apiKey', '')
  } catch (err) {
    console.warn('CFG Core | failed to clear apiKey setting:', err)
  }
  resetState({ status: 'idle' })
  emit()
}

/* -------------------------------------------- */
/*  Poll loop                                    */
/* -------------------------------------------- */

async function _scheduleNextPoll() {
  if (state.status !== 'pending' || !state.pairId) return
  pollTimer = setTimeout(() => {
    void _pollOnce()
  }, POLL_INTERVAL_MS)
  // unref isn't available in browser timers, so the timer naturally lives
  // for the full duration of the flow or until cancelled.
}

async function _pollOnce() {
  if (state.status !== 'pending' || !state.pairId) return
  const endpoint = getCfgEndpoint()

  let res
  try {
    res = await fetch(`${endpoint}/api/v1/public/pair/${encodeURIComponent(state.pairId)}`, {
      method: 'GET',
      credentials: 'omit',
    })
  } catch {
    // Transient network error — keep polling. The expiry timer will catch
    // a hung connection.
    await _scheduleNextPoll()
    return
  }

  if (!res.ok) {
    if (res.status === 404) {
      clearTimers()
      resetState({ status: 'expired' })
      emit()
      return
    }
    await _scheduleNextPoll()
    return
  }

  let payload
  try {
    payload = await res.json()
  } catch {
    await _scheduleNextPoll()
    return
  }

  if (payload?.status === 'expired') {
    clearTimers()
    resetState({ status: 'expired' })
    emit()
    return
  }

  if (payload?.status === 'completed' && payload?.apiKey) {
    clearTimers()
    try {
      await game.settings.set(MODULE_ID, 'apiKey', payload.apiKey)
      // installationId may be added by #700; store it if present so future
      // calls can reference the specific Foundry instance row.
      if (payload.installationId) {
        await game.settings.set(MODULE_ID, 'installationId', payload.installationId)
      }
    } catch (err) {
      resetState({ status: 'error', error: err?.message || 'Failed to store key' })
      emit()
      return
    }
    resetState({ status: 'completed' })
    emit()
    return
  }

  // status === 'pending' or unrecognised — keep polling.
  await _scheduleNextPoll()
}

/* -------------------------------------------- */
/*  Foundry context readers                      */
/* -------------------------------------------- */

function _readFoundryUrl() {
  try {
    if (typeof window !== 'undefined' && window.location?.origin) {
      return window.location.origin
    }
  } catch {
    /* sandbox edge case */
  }
  return undefined
}

function _readFoundryWorldId() {
  try {
    return game?.world?.id || undefined
  } catch {
    return undefined
  }
}

function _readFoundryUserId() {
  try {
    return game?.user?.id || undefined
  } catch {
    return undefined
  }
}
