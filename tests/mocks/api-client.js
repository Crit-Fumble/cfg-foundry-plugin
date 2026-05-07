/**
 * Reusable CoreAPIClient mock for Jest unit tests.
 *
 * Usage:
 *   import { createMockApiClient } from '../mocks/api-client.js'
 *
 *   const api = createMockApiClient({
 *     getQuests: jest.fn().mockResolvedValue({ quests: [] }),
 *   })
 */

import { jest } from '@jest/globals'

/**
 * Creates a mock CoreAPIClient with all methods stubbed as jest.fn().
 * Pass overrides to pre-configure specific method return values.
 *
 * @param {Partial<Record<string, jest.Mock>>} overrides
 * @returns {import('../../scripts/clients/api-client.js').CoreAPIClient}
 */
export function createMockApiClient(overrides = {}) {
  return {
    baseUrl: 'https://core.crit-fumble.com',
    apiKey: null,

    // Generic request methods
    get: jest.fn().mockResolvedValue({}),
    post: jest.fn().mockResolvedValue({}),
    patch: jest.fn().mockResolvedValue({}),
    del: jest.fn().mockResolvedValue({}),
    request: jest.fn().mockResolvedValue({}),

    // Named campaign methods
    getCampaign: jest.fn().mockResolvedValue({}),
    getFoundryConfig: jest.fn().mockResolvedValue({ defaultModules: [] }),
    updateFoundry: jest.fn().mockResolvedValue({ featureMode: 'narrative', platformSystemSlug: null }),
    getParties: jest.fn().mockResolvedValue({ parties: [] }),
    getActiveSession: jest.fn().mockResolvedValue(null),
    getSessions: jest.fn().mockResolvedValue({ sessions: [] }),
    getQuests: jest.fn().mockResolvedValue({ quests: [] }),
    updateQuest: jest.fn().mockResolvedValue({}),
    joinVoice: jest.fn().mockResolvedValue({ token: 'test-token', url: 'ws://localhost', roomName: 'test-room' }),
    getJournal: jest.fn().mockResolvedValue({}),
    gmAssist: jest.fn().mockResolvedValue({ response: '' }),

    ...overrides,
  }
}

/**
 * Creates a mock CoreAPIClient that rejects all requests with an auth error.
 * Useful for testing error-handling paths.
 *
 * @param {'session'|'apikey'} mode — determines the error message format
 */
export function createUnauthorizedApiClient(mode = 'session') {
  const message =
    mode === 'apikey'
      ? 'Invalid or expired CFG API key. Regenerate it in your Core account settings.'
      : 'Not logged in to Core. Open core.crit-fumble.com in your browser and sign in.'

  const reject = jest.fn().mockRejectedValue(new Error(message))
  return createMockApiClient({
    get: reject,
    post: reject,
    patch: reject,
    del: reject,
    request: reject,
  })
}
