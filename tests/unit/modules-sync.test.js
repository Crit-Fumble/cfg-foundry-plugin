/**
 * Installed-module sync (#339)
 *
 * Covers:
 *   - readWorldModules projects V13 `.contents` and V12 Map shapes to the same wire shape
 *   - compatibility.{minimum,verified,maximum} are passed through, omitted when absent
 *   - syncInstalledModules POSTs to /api/v1/foundry/modules with the full list
 *   - non-GM users skip the sync entirely (no fetch, no write)
 *   - fetchCfg failures are non-fatal (returned as a typed result, never thrown)
 */

import { jest } from '@jest/globals'

function settingsStore(initial = {}) {
  const map = new Map(Object.entries(initial))
  game.settings.get = jest.fn((_mod, key) => map.get(key))
  game.settings.set = jest.fn(async (_mod, key, value) => {
    map.set(key, value)
  })
  return map
}

async function loadModulesSync() {
  jest.resetModules()
  return await import('../../scripts/sync/modules-sync.js')
}

describe('readWorldModules', () => {
  beforeEach(() => {
    game.user = { isGM: true, id: 'test-gm-id', name: 'Test GM' }
  })

  it('projects Foundry V13+ `.contents` modules to the wire shape', async () => {
    game.modules = {
      contents: [
        {
          id: 'dnd5e-content',
          title: 'D&D 5e Content',
          version: '4.1.2',
          compatibility: { minimum: '12', verified: '13', maximum: '14' },
        },
        {
          id: 'lib-wrapper',
          title: 'libWrapper',
          version: '1.13.2',
          // No compatibility — should be omitted from the projection.
        },
      ],
    }

    const { readWorldModules } = await loadModulesSync()
    const out = readWorldModules()

    // Sorted by id.
    expect(out).toEqual([
      {
        id: 'dnd5e-content',
        title: 'D&D 5e Content',
        version: '4.1.2',
        compatibility: { minimum: '12', verified: '13', maximum: '14' },
      },
      {
        id: 'lib-wrapper',
        title: 'libWrapper',
        version: '1.13.2',
      },
    ])
  })

  it('falls back to Map.entries() when `.contents` is not an array (V12 shape)', async () => {
    const map = new Map([
      ['mod-a', { id: 'mod-a', title: 'Module A', version: '1.0.0' }],
      ['mod-b', { id: 'mod-b', title: 'Module B', version: '2.0.0' }],
    ])
    // No `.contents` — pure Map.
    game.modules = map

    const { readWorldModules } = await loadModulesSync()
    const out = readWorldModules()

    expect(out).toEqual([
      { id: 'mod-a', title: 'Module A', version: '1.0.0' },
      { id: 'mod-b', title: 'Module B', version: '2.0.0' },
    ])
  })

  it('returns [] when game.modules is missing', async () => {
    game.modules = undefined
    const { readWorldModules } = await loadModulesSync()
    expect(readWorldModules()).toEqual([])
  })

  it('skips entries without an id', async () => {
    game.modules = {
      contents: [{ title: 'Anonymous', version: '1.0.0' }, null, { id: 'real-mod', title: 'Real', version: '1.0.0' }],
    }
    const { readWorldModules } = await loadModulesSync()
    const out = readWorldModules()
    expect(out).toEqual([{ id: 'real-mod', title: 'Real', version: '1.0.0' }])
  })

  it('omits compatibility entirely when every key is missing', async () => {
    game.modules = {
      contents: [{ id: 'm', title: 'M', version: '1.0.0', compatibility: {} }],
    }
    const { readWorldModules } = await loadModulesSync()
    const out = readWorldModules()
    expect(out[0]).toEqual({ id: 'm', title: 'M', version: '1.0.0' })
    expect('compatibility' in out[0]).toBe(false)
  })
})

describe('syncInstalledModules', () => {
  let fetchSpy

  beforeEach(() => {
    settingsStore({
      coreApiUrl: 'https://core.crit-fumble.com',
      apiKey: 'cfk_test',
    })
    game.user = { isGM: true, id: 'test-gm-id', name: 'Test GM' }
    game.modules = {
      contents: [{ id: 'mod-1', title: 'Mod One', version: '1.0.0' }],
    }
    fetchSpy = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ count: 1, syncedAt: '2026-04-25T00:00:00Z' }),
      text: async () => '',
    }))
    globalThis.fetch = fetchSpy
  })

  it('POSTs /api/v1/foundry/modules with the projected module list', async () => {
    const { syncInstalledModules } = await loadModulesSync()
    const result = await syncInstalledModules()

    expect(result).toEqual({ ok: true, count: 1 })
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://core.crit-fumble.com/api/v1/foundry/modules')
    expect(init.method).toBe('POST')

    const body = JSON.parse(init.body)
    expect(body).toEqual({
      modules: [{ id: 'mod-1', title: 'Mod One', version: '1.0.0' }],
    })

    // Authorization header is set by fetchCfg.
    const auth = init.headers.get('Authorization')
    expect(auth).toBe('Bearer cfk_test')
  })

  it('skips entirely when the user is not the GM (no fetch)', async () => {
    game.user = { isGM: false, id: 'player-id' }

    const { syncInstalledModules } = await loadModulesSync()
    const result = await syncInstalledModules()

    expect(result).toEqual({ ok: false, reason: 'not-gm' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns a typed failure result when the server returns 401 — does not throw', async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: 'unauthenticated' }),
      text: async () => '{"error":"unauthenticated"}',
    }))

    const { syncInstalledModules } = await loadModulesSync()
    const result = await syncInstalledModules()

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('auth-failed')
    expect(result.status).toBe(401)
  })

  it('returns offline result when fetch rejects (DNS/timeout) — does not throw', async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED')
    })

    const { syncInstalledModules } = await loadModulesSync()
    const result = await syncInstalledModules()

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('offline')
  })

  it('still POSTs (with empty modules array) when the world has zero modules', async () => {
    game.modules = { contents: [] }

    const { syncInstalledModules } = await loadModulesSync()
    const result = await syncInstalledModules()

    expect(result).toEqual({ ok: true, count: 0 })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body).toEqual({ modules: [] })
  })
})
