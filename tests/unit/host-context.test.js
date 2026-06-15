/**
 * Host-environment detection (#699 / epic #419) — unit tests for the
 * window-global discriminator that distinguishes CFG-hosted Foundry from
 * self-hosted / third-party-hosted Foundry.
 */

import { jest } from '@jest/globals'

const MODULE_ID = 'crit-fumble-core'

/**
 * Re-import the host-context module fresh per test so the cached one-shot
 * read is reset. Mirrors the pair-flow.test.js pattern.
 */
async function loadHostContext() {
  jest.resetModules()
  return await import('../../scripts/auth/host-context.js')
}

function settingsStore(initial = {}) {
  const map = new Map(Object.entries(initial))
  game.settings.get = jest.fn((_mod, key) => map.get(key))
  game.settings.set = jest.fn(async (_mod, key, value) => {
    map.set(key, value)
  })
  return map
}

describe('getHostKind', () => {
  beforeEach(() => {
    globalThis.window = globalThis.window || {}
    delete globalThis.window.__CFG_HOSTED_CONTEXT__
    // Non-hosted path by default — self-hosted Foundry is never served on the
    // `/servers/foundryvtt/` prefix, so the URL fallback stays off unless a
    // test opts in.
    globalThis.window.location = { pathname: '/game', origin: 'https://foundry.local' }
    settingsStore({})
  })

  it("returns 'cfg-hosted' when the injected global is well-formed", async () => {
    globalThis.window.__CFG_HOSTED_CONTEXT__ = {
      endpoint: 'https://core.crit-fumble.com',
      apiKey: 'cfk_injected',
      installationId: 'inst_abc',
      cfgUserId: 'user_xyz',
    }
    const { getHostKind } = await loadHostContext()
    expect(getHostKind()).toBe('cfg-hosted')
  })

  it("returns 'self-hosted' when the global is absent and the path is not hosted", async () => {
    const { getHostKind } = await loadHostContext()
    expect(getHostKind()).toBe('self-hosted')
  })

  it("returns 'cfg-hosted' from the URL path even when no global is injected", async () => {
    // The common case today: the proxy hasn't injected __CFG_HOSTED_CONTEXT__,
    // but the container is served under /servers/foundryvtt/<installationId>/.
    // A world created via Foundry's own setup UI (no apiKey, no global) is
    // still cfg-hosted by virtue of its route.
    globalThis.window.location = {
      pathname: '/servers/foundryvtt/cmpn6xzfa000h01qdjr15ey1t/game',
      origin: 'https://core.crit-fumble.com',
    }
    const { getHostKind } = await loadHostContext()
    expect(getHostKind()).toBe('cfg-hosted')
  })

  it("getHostedContext stays null on the path fallback — no auth payload without the global", async () => {
    globalThis.window.location = {
      pathname: '/servers/foundryvtt/cmpn6xzfa000h01qdjr15ey1t/game',
      origin: 'https://core.crit-fumble.com',
    }
    const { getHostKind, getHostedContext } = await loadHostContext()
    expect(getHostKind()).toBe('cfg-hosted')
    // The path proves hosting, but only the injected global carries the apiKey.
    expect(getHostedContext()).toBeNull()
  })

  it("returns 'self-hosted' when the global is missing required fields", async () => {
    // Partial contexts are rejected — no endpoint means no auto-link is
    // possible, so we fall through to the pair flow.
    globalThis.window.__CFG_HOSTED_CONTEXT__ = {
      endpoint: 'https://core.crit-fumble.com',
      apiKey: 'cfk_injected',
      // missing installationId + cfgUserId
    }
    const { getHostKind } = await loadHostContext()
    expect(getHostKind()).toBe('self-hosted')
  })

  it("returns 'self-hosted' when an injected field is empty string", async () => {
    globalThis.window.__CFG_HOSTED_CONTEXT__ = {
      endpoint: '',
      apiKey: 'cfk_injected',
      installationId: 'inst_abc',
      cfgUserId: 'user_xyz',
    }
    const { getHostKind } = await loadHostContext()
    expect(getHostKind()).toBe('self-hosted')
  })

  it('caches the result — tampering with the global after the first read is ignored', async () => {
    globalThis.window.__CFG_HOSTED_CONTEXT__ = {
      endpoint: 'https://core.crit-fumble.com',
      apiKey: 'cfk_injected',
      installationId: 'inst_abc',
      cfgUserId: 'user_xyz',
    }
    const { getHostKind } = await loadHostContext()
    expect(getHostKind()).toBe('cfg-hosted')

    delete globalThis.window.__CFG_HOSTED_CONTEXT__
    expect(getHostKind()).toBe('cfg-hosted')
  })
})

describe('applyHostedContext', () => {
  let store

  beforeEach(() => {
    globalThis.window = globalThis.window || {}
    delete globalThis.window.__CFG_HOSTED_CONTEXT__
    store = settingsStore({ coreApiUrl: 'https://default', apiKey: '', installationId: '' })
  })

  it('writes endpoint, apiKey and installationId from the injected global', async () => {
    globalThis.window.__CFG_HOSTED_CONTEXT__ = {
      endpoint: 'https://cfg.example.com/',
      apiKey: 'cfk_injected',
      installationId: 'inst_abc',
      cfgUserId: 'user_xyz',
    }

    const { applyHostedContext } = await loadHostContext()
    const kind = await applyHostedContext()

    expect(kind).toBe('cfg-hosted')
    // Trailing slash on endpoint is stripped — fetch helpers append paths
    // with a leading slash and double slashes break some upstream proxies.
    expect(store.get('coreApiUrl')).toBe('https://cfg.example.com')
    expect(store.get('apiKey')).toBe('cfk_injected')
    expect(store.get('installationId')).toBe('inst_abc')
  })

  it("returns 'self-hosted' and writes nothing when the global is absent", async () => {
    const { applyHostedContext } = await loadHostContext()
    const kind = await applyHostedContext()

    expect(kind).toBe('self-hosted')
    expect(game.settings.set).not.toHaveBeenCalled()
  })

  it('skips the write when the setting already matches — no spurious change hooks', async () => {
    globalThis.window.__CFG_HOSTED_CONTEXT__ = {
      endpoint: 'https://cfg.example.com',
      apiKey: 'cfk_injected',
      installationId: 'inst_abc',
      cfgUserId: 'user_xyz',
    }
    settingsStore({
      coreApiUrl: 'https://cfg.example.com',
      apiKey: 'cfk_injected',
      installationId: 'inst_abc',
    })

    const { applyHostedContext } = await loadHostContext()
    await applyHostedContext()

    expect(game.settings.set).not.toHaveBeenCalled()
  })
})

describe('getHostedContext', () => {
  beforeEach(() => {
    globalThis.window = globalThis.window || {}
    delete globalThis.window.__CFG_HOSTED_CONTEXT__
  })

  it('returns the normalised context object when the global is well-formed', async () => {
    globalThis.window.__CFG_HOSTED_CONTEXT__ = {
      endpoint: 'https://core.crit-fumble.com/',
      apiKey: 'cfk_injected',
      installationId: 'inst_abc',
      cfgUserId: 'user_xyz',
    }
    const { getHostedContext } = await loadHostContext()
    expect(getHostedContext()).toEqual({
      endpoint: 'https://core.crit-fumble.com',
      apiKey: 'cfk_injected',
      installationId: 'inst_abc',
      cfgUserId: 'user_xyz',
    })
  })

  it('returns null when the global is absent', async () => {
    const { getHostedContext } = await loadHostContext()
    expect(getHostedContext()).toBeNull()
  })
})
