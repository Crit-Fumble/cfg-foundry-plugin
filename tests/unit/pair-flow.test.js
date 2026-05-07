/**
 * Pair flow (#698 / epic #419) — happy path + the failure modes the settings
 * UI relies on. Polling intervals are short-circuited via fake timers so the
 * suite stays under a second.
 */

import { jest } from '@jest/globals'

const MODULE_ID = 'crit-fumble-core'

/**
 * Re-import the pair-flow module fresh per test so the in-module pair state
 * (status, timers, listeners) starts from idle.
 */
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

function mockResponse({ ok = true, status = 200, json = {} } = {}) {
  return {
    ok,
    status,
    json: async () => json,
  }
}

describe('fetchCfg', () => {
  beforeEach(() => {
    jest.useRealTimers()
    settingsStore({ coreApiUrl: 'https://cfg.test', apiKey: 'cfk_secret' })
    globalThis.fetch = jest.fn(async () => mockResponse({ json: { ok: true } }))
    globalThis.window = globalThis.window || {}
    globalThis.window.location = { origin: 'https://foundry.local' }
  })

  it('attaches Bearer token from settings and strips caller-supplied auth', async () => {
    const { fetchCfg } = await loadPairFlow()
    await fetchCfg('/api/v1/account/user', {
      headers: { Authorization: 'Bearer attacker', 'X-Trace': 'abc' },
    })

    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('https://cfg.test/api/v1/account/user')
    const headers = init.headers
    expect(headers.get('Authorization')).toBe('Bearer cfk_secret')
    expect(headers.get('X-Trace')).toBe('abc')
    expect(init.credentials).toBe('omit')
  })

  it('omits Authorization when no apiKey is set', async () => {
    settingsStore({ coreApiUrl: 'https://cfg.test', apiKey: '' })
    const { fetchCfg } = await loadPairFlow()
    await fetchCfg('/api/v1/public/ping')
    const [, init] = fetch.mock.calls[0]
    expect(init.headers.has('Authorization')).toBe(false)
  })

  it('falls back to default endpoint when setting is missing', async () => {
    settingsStore({})
    const { fetchCfg } = await loadPairFlow()
    await fetchCfg('/x')
    const [url] = fetch.mock.calls[0]
    expect(url).toBe('https://core.crit-fumble.com/x')
  })
})

describe('startPairFlow', () => {
  let store

  beforeEach(() => {
    jest.useFakeTimers()
    store = settingsStore({ coreApiUrl: 'https://cfg.test', apiKey: '' })
    globalThis.window = globalThis.window || {}
    globalThis.window.location = { origin: 'https://foundry.local' }
    globalThis.window.open = jest.fn()
    globalThis.game.world = { id: 'world-abc' }
    globalThis.game.user = { id: 'user-xyz', isGM: true }
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('posts the start-pair body, opens the browser tab, and stores the apiKey on completion', async () => {
    let pollCount = 0
    globalThis.fetch = jest.fn(async (url, init) => {
      if (url.endsWith('/api/v1/public/pair') && init?.method === 'POST') {
        // Verify the body carries the Foundry-instance metadata #700 expects.
        const body = JSON.parse(init.body)
        expect(body).toMatchObject({
          platform: 'foundry',
          foundryUrl: 'https://foundry.local',
          foundryWorldId: 'world-abc',
          foundryUserId: 'user-xyz',
        })
        return mockResponse({
          status: 201,
          json: { pairId: 'pid-1', code: 'ABCDE-FGHJK-LMNP', expiresAt: '2099-01-01T00:00:00Z' },
        })
      }
      if (url.includes('/api/v1/public/pair/pid-1')) {
        pollCount++
        if (pollCount === 1) return mockResponse({ json: { status: 'pending' } })
        return mockResponse({ json: { status: 'completed', apiKey: 'cfk_minted' } })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const { startPairFlow, getPairState } = await loadPairFlow()
    const flowPromise = startPairFlow()

    // Allow the POST to resolve.
    await jest.advanceTimersByTimeAsync(0)

    expect(getPairState()).toMatchObject({ status: 'pending', code: 'ABCDE-FGHJK-LMNP' })
    expect(window.open).toHaveBeenCalledWith('https://cfg.test/pair/ABCDE-FGHJK-LMNP', '_blank', 'noopener,noreferrer')

    // Two poll cycles: first → 'pending', second → 'completed'.
    await jest.advanceTimersByTimeAsync(3_000)
    await jest.advanceTimersByTimeAsync(3_000)
    await flowPromise

    expect(getPairState().status).toBe('completed')
    expect(store.get('apiKey')).toBe('cfk_minted')
  })

  it('exposes status="error" when the start-pair request fails', async () => {
    globalThis.fetch = jest.fn(async () =>
      mockResponse({ ok: false, status: 400, json: { error: 'Unknown platform: foundry' } }),
    )

    const { startPairFlow, getPairState } = await loadPairFlow()
    await startPairFlow({ openWindow: false })

    expect(getPairState()).toMatchObject({ status: 'error', error: 'Unknown platform: foundry' })
    expect(store.get('apiKey')).toBe('')
  })

  it('marks the flow expired after the 5-minute timeout', async () => {
    globalThis.fetch = jest.fn(async (url, init) => {
      if (init?.method === 'POST') {
        return mockResponse({ status: 201, json: { pairId: 'pid-2', code: 'CODE' } })
      }
      return mockResponse({ json: { status: 'pending' } })
    })

    const { startPairFlow, getPairState } = await loadPairFlow()
    await startPairFlow({ openWindow: false })

    await jest.advanceTimersByTimeAsync(5 * 60 * 1000 + 100)

    expect(getPairState().status).toBe('expired')
  })

  it('treats a 404 poll response as expired immediately', async () => {
    globalThis.fetch = jest.fn(async (url, init) => {
      if (init?.method === 'POST') {
        return mockResponse({ status: 201, json: { pairId: 'pid-3', code: 'CODE3' } })
      }
      return mockResponse({ ok: false, status: 404, json: {} })
    })

    const { startPairFlow, getPairState } = await loadPairFlow()
    await startPairFlow({ openWindow: false })
    await jest.advanceTimersByTimeAsync(3_500)

    expect(getPairState().status).toBe('expired')
  })

  it('cancels in-flight polling on cancelPairFlow()', async () => {
    globalThis.fetch = jest.fn(async (url, init) => {
      if (init?.method === 'POST') {
        return mockResponse({ status: 201, json: { pairId: 'pid-4', code: 'CODE4' } })
      }
      return mockResponse({ json: { status: 'pending' } })
    })

    const { startPairFlow, cancelPairFlow, getPairState } = await loadPairFlow()
    await startPairFlow({ openWindow: false })
    expect(getPairState().status).toBe('pending')

    cancelPairFlow()
    expect(getPairState().status).toBe('idle')

    // Advancing past the would-be poll interval should not flip state back.
    await jest.advanceTimersByTimeAsync(10_000)
    expect(getPairState().status).toBe('idle')
  })
})

describe('unlinkPair', () => {
  it('clears the stored apiKey via game.settings.set', async () => {
    const store = settingsStore({ apiKey: 'cfk_existing' })
    const { unlinkPair, isLinked } = await loadPairFlow()

    expect(isLinked()).toBe(true)
    await unlinkPair()

    expect(game.settings.set).toHaveBeenCalledWith(MODULE_ID, 'apiKey', '')
    expect(store.get('apiKey')).toBe('')
  })
})
