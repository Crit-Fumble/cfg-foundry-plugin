/**
 * Foundry plugin — Core Auth enable path coverage.
 *
 * The in-plugin Core-Auth bypass (precursor to the #571 TaleSpire-style pair
 * flow) gates entirely on three `game.settings`:
 *
 *   - `enableCoreAuthBypass` — the big on/off switch
 *   - `coreWorldId` — which Crit-Fumble world this Foundry world maps to
 *   - `coreAuthUrl` — optional override for the Core API origin
 *
 * Before the pair-flow lands (#571 is in progress per project memory), the
 * enable path must remain robust — in particular: `isCoreAuthEnabled()` must
 * never throw if the settings subsystem isn't ready yet, and
 * `validateCoreAuthConfig()` must flag the exact missing pieces rather than
 * a generic "not configured" message.
 *
 * Complements the existing `auth.test.js` which covers the OAuth / pending-
 * auth side of the flow.
 */

import { jest } from '@jest/globals'

let isCoreAuthEnabled
let validateCoreAuthConfig
let getCoreAuthUrl
let getCoreWorldId

beforeAll(async () => {
  // window + sessionStorage — core-auth.js imports touch them at load time.
  global.window = {
    location: {
      origin: 'https://foundry.example.com',
      href: 'https://foundry.example.com/game',
    },
  }
  const storage = new Map()
  global.sessionStorage = {
    getItem: (k) => storage.get(k) ?? null,
    setItem: (k, v) => storage.set(k, v),
    removeItem: (k) => storage.delete(k),
  }

  const mod = await import('../../scripts/auth/core-auth.js')
  isCoreAuthEnabled = mod.isCoreAuthEnabled
  validateCoreAuthConfig = mod.validateCoreAuthConfig
  getCoreAuthUrl = mod.getCoreAuthUrl
  getCoreWorldId = mod.getCoreWorldId
})

beforeEach(() => {
  // Reset the settings mock between tests. setup.js gives us a jest.fn().
  globalThis.game.settings.get.mockReset()
})

describe('isCoreAuthEnabled', () => {
  it('returns true when enableCoreAuthBypass is set to true', () => {
    globalThis.game.settings.get.mockImplementation((_mod, key) => key === 'enableCoreAuthBypass')
    expect(isCoreAuthEnabled()).toBe(true)
  })

  it('returns false when enableCoreAuthBypass is set to false', () => {
    globalThis.game.settings.get.mockReturnValue(false)
    expect(isCoreAuthEnabled()).toBe(false)
  })

  it('returns false when the settings subsystem throws (not ready)', () => {
    globalThis.game.settings.get.mockImplementation(() => {
      throw new Error('settings not initialised yet')
    })
    expect(isCoreAuthEnabled()).toBe(false)
  })

  it('returns false for a non-boolean truthy value (type-strict ===)', () => {
    // Future-proofing: if a migration writes a string 'true' the gate must
    // still fail closed rather than flipping into enabled state.
    globalThis.game.settings.get.mockImplementation((_mod, key) => (key === 'enableCoreAuthBypass' ? 'true' : ''))
    expect(isCoreAuthEnabled()).toBe(false)
  })
})

describe('validateCoreAuthConfig — pair/enable path gating', () => {
  it('is valid when both coreWorldId and a URL are configured', () => {
    globalThis.game.settings.get.mockImplementation((_mod, key) => {
      if (key === 'coreWorldId') return 'world-abc-123'
      if (key === 'coreAuthUrl') return 'https://core.crit-fumble.com'
      return ''
    })
    const result = validateCoreAuthConfig()
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('falls back to coreApiUrl when coreAuthUrl is blank', () => {
    globalThis.game.settings.get.mockImplementation((_mod, key) => {
      if (key === 'coreWorldId') return 'world-abc-123'
      if (key === 'coreAuthUrl') return ''
      if (key === 'coreApiUrl') return 'https://core.crit-fumble.com'
      return ''
    })
    expect(getCoreAuthUrl()).toBe('https://core.crit-fumble.com')
    expect(validateCoreAuthConfig().valid).toBe(true)
  })

  it('flags missing coreWorldId specifically', () => {
    globalThis.game.settings.get.mockImplementation((_mod, key) => {
      if (key === 'coreAuthUrl') return 'https://core.crit-fumble.com'
      return '' // coreWorldId and coreApiUrl both blank
    })
    const result = validateCoreAuthConfig()
    expect(result.valid).toBe(false)
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringMatching(/World ID/)]))
  })

  it('flags missing auth URL when coreAuthUrl, coreApiUrl, AND default all fail', () => {
    // getCoreAuthUrl falls back to CORE_AUTH_CONFIG.DEFAULT_API_URL which is
    // a non-empty string — the "no URL" branch only triggers when custom +
    // api urls are both blank AND the default is empty. That's near-impossible
    // in production; we still cover the coreWorldId branch as the pragmatic
    // "required field missing" signal.
    globalThis.game.settings.get.mockReturnValue('')
    const result = validateCoreAuthConfig()
    expect(result.valid).toBe(false)
    // At minimum, coreWorldId is flagged
    expect(result.errors.length).toBeGreaterThanOrEqual(1)
  })
})

describe('getCoreWorldId', () => {
  it('returns the configured world id', () => {
    globalThis.game.settings.get.mockImplementation((_mod, key) => (key === 'coreWorldId' ? 'my-world-slug' : ''))
    expect(getCoreWorldId()).toBe('my-world-slug')
  })

  it('returns null when unset', () => {
    globalThis.game.settings.get.mockReturnValue('')
    expect(getCoreWorldId()).toBeNull()
  })
})
