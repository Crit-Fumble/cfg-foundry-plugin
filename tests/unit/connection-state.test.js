/**
 * Plugin connection-state observable + fetchCfg's offline branch (#699).
 *
 * Covers:
 *   - subscriber API: subscribe/unsubscribe + listener fanout
 *   - fetchCfg returns typed `{ ok, reason }` for every failure mode
 *     (offline, auth-failed, server-error, client-error)
 *   - fetchCfg never throws
 *   - connection-state mirrors the outcome of the last fetch
 */

import { jest } from '@jest/globals'

async function loadConnectionState() {
  jest.resetModules()
  return await import('../../scripts/auth/connection-state.js')
}

async function loadPairFlow() {
  jest.resetModules()
  return await import('../../scripts/auth/pair-flow.js')
}

function settingsStore(initial = {}) {
  const map = new Map(Object.entries(initial))
  game.settings.get = jest.fn((_mod, key) => map.get(key))
  game.settings.set = jest.fn(async (_mod, key, value) => {
    map.set(key, value)
  })
  return map
}

describe('connection-state subscribers', () => {
  it('starts in unknown and notifies subscribers on status changes', async () => {
    const { getConnectionState, onConnectionStateChange, setConnectionStatus } = await loadConnectionState()
    expect(getConnectionState().status).toBe('unknown')

    const seen = []
    const unsubscribe = onConnectionStateChange((s) => seen.push(s.status))

    setConnectionStatus('online', 200)
    setConnectionStatus('offline')
    setConnectionStatus('online', 200)

    expect(seen).toEqual(['online', 'offline', 'online'])
    expect(getConnectionState()).toMatchObject({ status: 'online', lastStatusCode: 200 })

    unsubscribe()
  })

  it('does not re-emit when the status repeats', async () => {
    const { onConnectionStateChange, setConnectionStatus } = await loadConnectionState()
    const seen = []
    onConnectionStateChange((s) => seen.push(s.status))

    setConnectionStatus('offline')
    setConnectionStatus('offline')
    setConnectionStatus('offline')

    expect(seen).toEqual(['offline'])
  })

  it('unsubscribed listeners stop receiving updates', async () => {
    const { onConnectionStateChange, setConnectionStatus } = await loadConnectionState()
    const seen = []
    const unsubscribe = onConnectionStateChange((s) => seen.push(s.status))

    setConnectionStatus('online', 200)
    unsubscribe()
    setConnectionStatus('offline')

    expect(seen).toEqual(['online'])
  })

  it('a throwing listener does not block other listeners', async () => {
    const { onConnectionStateChange, setConnectionStatus } = await loadConnectionState()
    const seen = []

    onConnectionStateChange(() => {
      throw new Error('boom')
    })
    onConnectionStateChange((s) => seen.push(s.status))

    setConnectionStatus('offline')
    expect(seen).toEqual(['offline'])
  })
})

describe('fetchCfg — typed result + connection-state side effects', () => {
  beforeEach(() => {
    settingsStore({ coreApiUrl: 'https://cfg.test', apiKey: 'cfk_secret' })
    globalThis.window = globalThis.window || {}
    globalThis.window.location = { origin: 'https://foundry.local' }
  })

  it('returns { ok: true, status, data } on a 2xx with JSON body', async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ user: { name: 'Hob' } }),
      text: async () => '{"user":{"name":"Hob"}}',
    }))

    const { fetchCfg } = await loadPairFlow()
    const res = await fetchCfg('/api/v1/account/user')

    expect(res).toEqual({ ok: true, status: 200, data: { user: { name: 'Hob' } } })
  })

  it("returns { ok: false, reason: 'offline' } when fetch throws", async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new TypeError('NetworkError when attempting to fetch resource.')
    })

    const { fetchCfg } = await loadPairFlow()
    const res = await fetchCfg('/api/v1/account/user')

    expect(res.ok).toBe(false)
    expect(res.reason).toBe('offline')
    expect(res.error).toMatch(/NetworkError/)
  })

  it("returns { ok: false, reason: 'auth-failed', status } on a 401", async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => '{"error":"Invalid API key"}',
    }))

    const { fetchCfg } = await loadPairFlow()
    const res = await fetchCfg('/api/v1/account/user')

    expect(res).toMatchObject({ ok: false, reason: 'auth-failed', status: 401, body: { error: 'Invalid API key' } })
  })

  it("returns { ok: false, reason: 'auth-failed', status } on a 403", async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => '',
    }))

    const { fetchCfg } = await loadPairFlow()
    const res = await fetchCfg('/api/v1/account/user')

    expect(res).toMatchObject({ ok: false, reason: 'auth-failed', status: 403 })
  })

  it("returns { ok: false, reason: 'server-error', status } on a 5xx", async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    }))

    const { fetchCfg } = await loadPairFlow()
    const res = await fetchCfg('/api/v1/account/user')

    expect(res).toMatchObject({ ok: false, reason: 'server-error', status: 503, body: 'Service Unavailable' })
  })

  it("returns { ok: false, reason: 'client-error', status } on a non-401/403 4xx", async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => '{"error":"Not found"}',
    }))

    const { fetchCfg } = await loadPairFlow()
    const res = await fetchCfg('/api/v1/path/missing')

    expect(res).toMatchObject({ ok: false, reason: 'client-error', status: 404, body: { error: 'Not found' } })
  })

  it('updates connection-state to online after a 2xx', async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '{}',
    }))

    const { fetchCfg } = await loadPairFlow()
    const { getConnectionState } = await import('../../scripts/auth/connection-state.js')

    await fetchCfg('/api/v1/health')
    expect(getConnectionState().status).toBe('online')
  })

  it('updates connection-state to offline when fetch throws', async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new Error('connect ECONNREFUSED')
    })

    const { fetchCfg } = await loadPairFlow()
    const { getConnectionState } = await import('../../scripts/auth/connection-state.js')

    await fetchCfg('/api/v1/health')
    expect(getConnectionState().status).toBe('offline')
  })

  it('does not throw — every error mode resolves to a typed result', async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new Error('catastrophe')
    })

    const { fetchCfg } = await loadPairFlow()
    await expect(fetchCfg('/x')).resolves.toMatchObject({ ok: false, reason: 'offline' })
  })
})
