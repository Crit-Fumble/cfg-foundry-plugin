/**
 * CoreAPIClient unit tests
 *
 * Covers both auth modes (core-hosted / self-hosted), HTTP verbs,
 * named campaign methods, error handling, retry, and timeout.
 */

import { jest } from '@jest/globals'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeResponse(status, body = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn(async () => body),
    text: jest.fn(async () => JSON.stringify(body)),
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let CoreAPIClient
let mockFetch

beforeAll(async () => {
  // Stable AbortController mock (doesn't auto-abort)
  globalThis.AbortController = class {
    constructor() {
      this.signal = { aborted: false }
    }
    abort() {
      this.signal.aborted = true
    }
  }
  globalThis.URLSearchParams =
    URLSearchParams ??
    class {
      constructor(params = {}) {
        this._p = params
      }
      toString() {
        return Object.entries(this._p)
          .map(([k, v]) => `${k}=${v}`)
          .join('&')
      }
    }

  const mod = await import('../../../scripts/clients/api-client.js')
  CoreAPIClient = mod.CoreAPIClient
})

beforeEach(() => {
  mockFetch = jest.fn(async () => makeResponse(200, {}))
  globalThis.fetch = mockFetch
})

afterEach(() => {
  jest.clearAllMocks()
})

// ── Constructor ───────────────────────────────────────────────────────────────

describe('constructor', () => {
  test('stores baseUrl without trailing slash', () => {
    const api = new CoreAPIClient('https://core.crit-fumble.com/')
    expect(api.baseUrl).toBe('https://core.crit-fumble.com')
  })

  test('defaults baseUrl when falsy', () => {
    const api = new CoreAPIClient(null)
    expect(api.baseUrl).toBe('https://core.crit-fumble.com')
  })

  test('apiKey is null in core-hosted mode', () => {
    const api = new CoreAPIClient('https://core.crit-fumble.com')
    expect(api.apiKey).toBeNull()
  })

  test('stores apiKey in self-hosted mode', () => {
    const api = new CoreAPIClient('https://core.crit-fumble.com', 'cfk_testkey')
    expect(api.apiKey).toBe('cfk_testkey')
  })

  test('treats empty-string apiKey as null', () => {
    const api = new CoreAPIClient('https://core.crit-fumble.com', '')
    expect(api.apiKey).toBeNull()
  })
})

// ── Auth modes ────────────────────────────────────────────────────────────────

describe('auth modes', () => {
  test('core-hosted: uses credentials:include, no Authorization header', async () => {
    const api = new CoreAPIClient('https://core.crit-fumble.com')
    await api.get('/api/test')
    const [, opts] = mockFetch.mock.calls[0]
    expect(opts.credentials).toBe('include')
    expect(opts.headers['Authorization']).toBeUndefined()
  })

  test('self-hosted: sends Bearer token, no credentials:include', async () => {
    const api = new CoreAPIClient('https://core.crit-fumble.com', 'cfk_secret')
    await api.get('/api/test')
    const [, opts] = mockFetch.mock.calls[0]
    expect(opts.headers['Authorization']).toBe('Bearer cfk_secret')
    expect(opts.credentials).toBeUndefined()
  })

  test('always sends Content-Type: application/json', async () => {
    const api = new CoreAPIClient('https://core.crit-fumble.com')
    await api.get('/api/test')
    const [, opts] = mockFetch.mock.calls[0]
    expect(opts.headers['Content-Type']).toBe('application/json')
  })
})

// ── HTTP verbs ────────────────────────────────────────────────────────────────

describe('HTTP verbs', () => {
  let api
  beforeEach(() => {
    api = new CoreAPIClient('https://core.crit-fumble.com')
  })

  test('get() uses GET method', async () => {
    await api.get('/api/foo')
    expect(mockFetch.mock.calls[0][1].method).toBe('GET')
  })

  test('post() uses POST and serialises body', async () => {
    await api.post('/api/foo', { name: 'bar' })
    const [, opts] = mockFetch.mock.calls[0]
    expect(opts.method).toBe('POST')
    expect(opts.body).toBe('{"name":"bar"}')
  })

  test('patch() uses PATCH and serialises body', async () => {
    await api.patch('/api/foo', { x: 1 })
    const [, opts] = mockFetch.mock.calls[0]
    expect(opts.method).toBe('PATCH')
    expect(opts.body).toBe('{"x":1}')
  })

  test('del() uses DELETE', async () => {
    await api.del('/api/foo')
    expect(mockFetch.mock.calls[0][1].method).toBe('DELETE')
  })

  test('constructs full URL from baseUrl + endpoint', async () => {
    await api.get('/api/campaigns/abc')
    expect(mockFetch.mock.calls[0][0]).toBe('https://core.crit-fumble.com/api/campaigns/abc')
  })

  test('returns parsed JSON body on success', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, { quests: [] }))
    const result = await api.get('/api/test')
    expect(result).toEqual({ quests: [] })
  })
})

// ── Error handling ─────────────────────────────────────────────────────────────

describe('error handling', () => {
  test('401 core-hosted: friendly login message', async () => {
    const api = new CoreAPIClient('https://core.crit-fumble.com')
    mockFetch.mockResolvedValueOnce(makeResponse(401))
    await expect(api.get('/api/test')).rejects.toThrow('Not logged in to Core')
  })

  test('401 self-hosted: friendly API key message', async () => {
    const api = new CoreAPIClient('https://core.crit-fumble.com', 'cfk_bad')
    mockFetch.mockResolvedValueOnce(makeResponse(401))
    await expect(api.get('/api/test')).rejects.toThrow('Invalid or expired CFG API key')
  })

  test('403 throws permission error', async () => {
    const api = new CoreAPIClient('https://core.crit-fumble.com')
    mockFetch.mockResolvedValueOnce(makeResponse(403))
    await expect(api.get('/api/test')).rejects.toThrow('permission')
  })

  test('404 throws not-found error', async () => {
    const api = new CoreAPIClient('https://core.crit-fumble.com')
    mockFetch.mockResolvedValueOnce(makeResponse(404))
    await expect(api.get('/api/test')).rejects.toThrow('not found')
  })

  test('429 throws rate-limit error', async () => {
    const api = new CoreAPIClient('https://core.crit-fumble.com')
    mockFetch.mockResolvedValueOnce(makeResponse(429))
    await expect(api.get('/api/test')).rejects.toThrow('Rate limited')
  })

  test('500 uses body.error if present', async () => {
    const api = new CoreAPIClient('https://core.crit-fumble.com')
    mockFetch.mockResolvedValueOnce(makeResponse(500, { error: 'Server exploded' }))
    await expect(api.get('/api/test')).rejects.toThrow('Server exploded')
  })

  test('500 falls back to generic message if no body.error', async () => {
    const api = new CoreAPIClient('https://core.crit-fumble.com')
    mockFetch.mockResolvedValueOnce(makeResponse(500, {}))
    await expect(api.get('/api/test')).rejects.toThrow('HTTP 500')
  })

  test('network failure propagates after retries', async () => {
    const api = new CoreAPIClient('https://core.crit-fumble.com')
    mockFetch.mockRejectedValue(new Error('Network error'))
    await expect(api.get('/api/test')).rejects.toThrow('Network error')
  })
})

// ── Retry logic ───────────────────────────────────────────────────────────────

describe('retry logic', () => {
  test('retries on network failure and succeeds on second attempt', async () => {
    jest.useFakeTimers()
    const api = new CoreAPIClient('https://core.crit-fumble.com')

    mockFetch.mockRejectedValueOnce(new Error('Network error')).mockResolvedValueOnce(makeResponse(200, { ok: true }))

    const promise = api.get('/api/test')
    await jest.runAllTimersAsync()
    const result = await promise

    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ ok: true })
    jest.useRealTimers()
  })

  test('does not retry on 4xx errors (HTTP error, not network error)', async () => {
    const api = new CoreAPIClient('https://core.crit-fumble.com')
    mockFetch.mockResolvedValue(makeResponse(404))
    // 404 is parsed and thrown immediately — fetch itself succeeded so no retry
    await expect(api.get('/api/test')).rejects.toThrow()
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})

// ── Named campaign methods ─────────────────────────────────────────────────────

describe('named campaign methods', () => {
  let api
  beforeEach(() => {
    api = new CoreAPIClient('https://core.crit-fumble.com')
    mockFetch.mockResolvedValue(makeResponse(200, {}))
  })

  test('getCampaign() hits /api/campaigns/{id}', async () => {
    await api.getCampaign('camp-1')
    expect(mockFetch.mock.calls[0][0]).toContain('/api/campaigns/camp-1')
    expect(mockFetch.mock.calls[0][1].method).toBe('GET')
  })

  test('getFoundryConfig() hits /api/campaigns/{id}/foundry/config', async () => {
    await api.getFoundryConfig('camp-1')
    expect(mockFetch.mock.calls[0][0]).toContain('/api/campaigns/camp-1/foundry/config')
  })

  test('updateFoundry() PATCHes /api/campaigns/{id}/foundry', async () => {
    await api.updateFoundry('camp-1', { foundrySystemId: 'dnd5e' })
    expect(mockFetch.mock.calls[0][1].method).toBe('PATCH')
    expect(mockFetch.mock.calls[0][0]).toContain('/api/campaigns/camp-1/foundry')
  })

  test('getParties() hits /api/campaigns/{id}/parties', async () => {
    await api.getParties('camp-1')
    expect(mockFetch.mock.calls[0][0]).toContain('/api/campaigns/camp-1/parties')
  })

  test('getActiveSession() hits /api/campaigns/{id}/sessions/active', async () => {
    await api.getActiveSession('camp-1')
    expect(mockFetch.mock.calls[0][0]).toContain('/api/campaigns/camp-1/sessions/active')
  })

  test('getQuests() hits /api/campaigns/{id}/quests', async () => {
    await api.getQuests('camp-1')
    expect(mockFetch.mock.calls[0][0]).toContain('/api/campaigns/camp-1/quests')
  })

  test('getQuests() appends query params', async () => {
    await api.getQuests('camp-1', { partyId: 'p1' })
    expect(mockFetch.mock.calls[0][0]).toContain('partyId=p1')
  })

  test('updateQuest() PATCHes /api/campaigns/{id}/quests/{questId}', async () => {
    await api.updateQuest('camp-1', 'q-1', { status: 'complete' })
    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toContain('/api/campaigns/camp-1/quests/q-1')
    expect(opts.method).toBe('PATCH')
  })

  test('joinVoice() POSTs to /api/campaigns/{id}/stream/webrtc/join', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, { token: 'tok', url: 'ws://lk', roomName: 'room' }))
    const result = await api.joinVoice('camp-1')
    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toContain('/api/campaigns/camp-1/stream/webrtc/join')
    expect(opts.method).toBe('POST')
    expect(result.token).toBe('tok')
  })

  test('getJournal() hits /api/campaigns/{id}/journal', async () => {
    await api.getJournal('camp-1')
    expect(mockFetch.mock.calls[0][0]).toContain('/api/campaigns/camp-1/journal')
  })

  test('gmAssist() POSTs prompt to /api/campaigns/{id}/gm-assist', async () => {
    await api.gmAssist('camp-1', 'describe the dungeon')
    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toContain('/api/campaigns/camp-1/gm-assist')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body).prompt).toBe('describe the dungeon')
  })
})
