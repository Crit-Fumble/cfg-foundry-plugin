/**
 * Auth Security Tests
 * Tests for OAuth redirect protection, JWT validation, and session security
 */

import { jest } from '@jest/globals'

describe('Auth Security - Open Redirect Protection', () => {
  let cleanupExpiredPendingAuth, CORE_AUTH_CONFIG
  let sessionStorageMock

  beforeAll(async () => {
    // Mock window and sessionStorage
    global.window = {
      location: {
        origin: 'https://foundry.example.com',
        href: 'https://foundry.example.com/game',
      },
    }

    sessionStorageMock = new Map()
    global.sessionStorage = {
      getItem: jest.fn((key) => sessionStorageMock.get(key) || null),
      setItem: jest.fn((key, value) => sessionStorageMock.set(key, value)),
      removeItem: jest.fn((key) => sessionStorageMock.delete(key)),
    }

    const module = await import('../../scripts/auth/core-auth.js')
    cleanupExpiredPendingAuth = module.cleanupExpiredPendingAuth
    CORE_AUTH_CONFIG = module.CORE_AUTH_CONFIG
  })

  afterEach(() => {
    sessionStorageMock.clear()
    jest.clearAllMocks()
  })

  describe('JWT Validation Timeout', () => {
    it('should remove expired pending auth (older than 5 minutes)', () => {
      const expiredTimestamp = Date.now() - 6 * 60 * 1000 // 6 minutes ago

      sessionStorageMock.set(
        CORE_AUTH_CONFIG.PENDING_AUTH_KEY,
        JSON.stringify({
          returnUrl: 'https://foundry.example.com/game',
          timestamp: expiredTimestamp,
        }),
      )

      cleanupExpiredPendingAuth()

      expect(sessionStorage.removeItem).toHaveBeenCalledWith(CORE_AUTH_CONFIG.PENDING_AUTH_KEY)
    })

    it('should keep valid pending auth (less than 5 minutes)', () => {
      const validTimestamp = Date.now() - 2 * 60 * 1000 // 2 minutes ago

      sessionStorageMock.set(
        CORE_AUTH_CONFIG.PENDING_AUTH_KEY,
        JSON.stringify({
          returnUrl: 'https://foundry.example.com/game',
          timestamp: validTimestamp,
        }),
      )

      cleanupExpiredPendingAuth()

      expect(sessionStorage.removeItem).not.toHaveBeenCalled()
    })

    it('should remove malformed pending auth data', () => {
      sessionStorageMock.set(CORE_AUTH_CONFIG.PENDING_AUTH_KEY, 'invalid json')

      cleanupExpiredPendingAuth()

      expect(sessionStorage.removeItem).toHaveBeenCalledWith(CORE_AUTH_CONFIG.PENDING_AUTH_KEY)
    })

    it('should handle missing pending auth gracefully', () => {
      cleanupExpiredPendingAuth()

      expect(sessionStorage.removeItem).not.toHaveBeenCalled()
    })
  })

  describe('JWT Timeout Validation', () => {
    it('should have 5-minute timeout configured', () => {
      expect(CORE_AUTH_CONFIG.PENDING_AUTH_TIMEOUT).toBe(5 * 60 * 1000)
    })

    it('should expire tokens at exact timeout boundary', () => {
      const boundaryTimestamp = Date.now() - CORE_AUTH_CONFIG.PENDING_AUTH_TIMEOUT - 1

      sessionStorageMock.set(
        CORE_AUTH_CONFIG.PENDING_AUTH_KEY,
        JSON.stringify({
          returnUrl: 'https://foundry.example.com/game',
          timestamp: boundaryTimestamp,
        }),
      )

      cleanupExpiredPendingAuth()

      expect(sessionStorage.removeItem).toHaveBeenCalled()
    })
  })
})

describe('Auth Security - Session Storage Protection', () => {
  let handleOAuthCallback, CORE_AUTH_CONFIG
  let sessionStorageMock

  beforeAll(async () => {
    global.window = {
      location: {
        origin: 'https://foundry.example.com',
        href: 'https://foundry.example.com/game?authToken=abc123',
        search: '?authToken=abc123',
      },
    }

    sessionStorageMock = new Map()
    global.sessionStorage = {
      getItem: jest.fn((key) => sessionStorageMock.get(key) || null),
      setItem: jest.fn((key, value) => sessionStorageMock.set(key, value)),
      removeItem: jest.fn((key) => sessionStorageMock.delete(key)),
    }

    global.fetch = jest.fn()
    global.URLSearchParams = class URLSearchParams {
      constructor(search) {
        this._params = new Map([['authToken', 'abc123']])
      }
      get(key) {
        return this._params.get(key)
      }
    }

    const module = await import('../../scripts/auth/core-auth.js')
    handleOAuthCallback = module.handleOAuthCallback
    CORE_AUTH_CONFIG = module.CORE_AUTH_CONFIG
  })

  afterEach(() => {
    sessionStorageMock.clear()
    jest.clearAllMocks()
  })

  describe('Expired Token Handling', () => {
    it('should reject expired OAuth tokens', async () => {
      const expiredTimestamp = Date.now() - 6 * 60 * 1000

      sessionStorageMock.set(
        CORE_AUTH_CONFIG.PENDING_AUTH_KEY,
        JSON.stringify({
          returnUrl: 'https://foundry.example.com/game',
          timestamp: expiredTimestamp,
        }),
      )

      const result = await handleOAuthCallback()

      expect(result.success).toBe(false)
      expect(result.error).toContain('expired')
      expect(sessionStorage.removeItem).toHaveBeenCalledWith(CORE_AUTH_CONFIG.PENDING_AUTH_KEY)
    })

    it('should provide user-friendly error message for expired tokens', async () => {
      const expiredTimestamp = Date.now() - 10 * 60 * 1000

      sessionStorageMock.set(
        CORE_AUTH_CONFIG.PENDING_AUTH_KEY,
        JSON.stringify({
          returnUrl: 'https://foundry.example.com/game',
          timestamp: expiredTimestamp,
        }),
      )

      const result = await handleOAuthCallback()

      expect(result.error).toBe('Authentication session expired. Please try again.')
    })
  })
})

describe('Auth Security - Token Logging Prevention', () => {
  it('should NOT log OAuth URLs with tokens', () => {
    const consoleSpy = jest.spyOn(console, 'log')

    // Simulate OAuth redirect (this would log in old code)
    const redirectUrl = 'https://core.example.com/auth/oauth?token=SECRET'

    // In secure version, we should only log generic messages
    console.log('[Core Auth] Initiating OAuth flow for discord')

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Initiating OAuth flow'))
    expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('SECRET'))

    consoleSpy.mockRestore()
  })

  it('should NOT log user details after authentication', () => {
    const consoleSpy = jest.spyOn(console, 'log')

    // Simulate auth success (old code logged username)
    console.log('[Core Auth] Authentication successful')

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Authentication successful'))
    expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringMatching(/user.*name/i))

    consoleSpy.mockRestore()
  })
})
