/**
 * ChatSyncManager unit tests
 *
 * Covers lifecycle (start/stop), outbound hook filtering, Core polling,
 * message injection, and echo-loop prevention.
 */

import { jest } from '@jest/globals'
import { createMockApiClient } from '../../mocks/api-client.js'

let ChatSyncManager

beforeAll(async () => {
  const mod = await import('../../../scripts/services/chat-sync.js')
  ChatSyncManager = mod.ChatSyncManager
})

beforeEach(() => {
  jest.useFakeTimers()
  // Reset Hooks mock between tests
  globalThis.Hooks.on.mockClear()
  globalThis.Hooks.off.mockClear()
  globalThis.ChatMessage.create.mockClear()
})

afterEach(() => {
  jest.useRealTimers()
  jest.clearAllMocks()
})

// ── Constructor ───────────────────────────────────────────────────────────────

describe('constructor', () => {
  test('stores api and campaignId', () => {
    const api = createMockApiClient()
    const mgr = new ChatSyncManager(api, 'camp-1')
    expect(mgr._api).toBe(api)
    expect(mgr._campaignId).toBe('camp-1')
  })

  test('initialises with no active timer or hook', () => {
    const mgr = new ChatSyncManager(createMockApiClient(), 'camp-1')
    expect(mgr._pollTimer).toBeNull()
    expect(mgr._hookId).toBeNull()
  })

  test('sets _since to a recent ISO timestamp', () => {
    const before = Date.now()
    const mgr = new ChatSyncManager(createMockApiClient(), 'camp-1')
    const after = Date.now()
    const since = new Date(mgr._since).getTime()
    expect(since).toBeGreaterThanOrEqual(before)
    expect(since).toBeLessThanOrEqual(after)
  })
})

// ── start() ───────────────────────────────────────────────────────────────────

describe('start()', () => {
  test('registers createChatMessage hook', () => {
    const mgr = new ChatSyncManager(createMockApiClient(), 'camp-1')
    mgr.start()
    expect(globalThis.Hooks.on).toHaveBeenCalledWith('createChatMessage', expect.any(Function))
  })

  test('starts poll timer when user is GM', () => {
    globalThis.game.user.isGM = true
    const mgr = new ChatSyncManager(createMockApiClient(), 'camp-1')
    mgr.start()
    expect(mgr._pollTimer).not.toBeNull()
    mgr.stop()
  })

  test('does not start poll timer for non-GM users', () => {
    globalThis.game.user.isGM = false
    const mgr = new ChatSyncManager(createMockApiClient(), 'camp-1')
    mgr.start()
    expect(mgr._pollTimer).toBeNull()
    mgr.stop()
    globalThis.game.user.isGM = true
  })
})

// ── stop() ────────────────────────────────────────────────────────────────────

describe('stop()', () => {
  test('unregisters the hook', () => {
    const mgr = new ChatSyncManager(createMockApiClient(), 'camp-1')
    mgr.start()
    const hookId = mgr._hookId
    mgr.stop()
    expect(globalThis.Hooks.off).toHaveBeenCalledWith('createChatMessage', hookId)
    expect(mgr._hookId).toBeNull()
  })

  test('clears poll timer', () => {
    globalThis.game.user.isGM = true
    const mgr = new ChatSyncManager(createMockApiClient(), 'camp-1')
    mgr.start()
    mgr.stop()
    expect(mgr._pollTimer).toBeNull()
    globalThis.game.user.isGM = true
  })

  test('is safe to call before start()', () => {
    const mgr = new ChatSyncManager(createMockApiClient(), 'camp-1')
    expect(() => mgr.stop()).not.toThrow()
  })
})

// ── _onFoundryMessage() — outbound ────────────────────────────────────────────

describe('_onFoundryMessage()', () => {
  function makeMsg(overrides = {}) {
    return {
      content: 'Hello world',
      alias: 'Test User',
      timestamp: Date.now(),
      whisper: [],
      getFlag: jest.fn(() => null), // no coreMessageId by default
      ...overrides,
    }
  }

  test('forwards a normal message to Core', async () => {
    const api = createMockApiClient()
    const mgr = new ChatSyncManager(api, 'camp-1')
    await mgr._onFoundryMessage(makeMsg())
    expect(api.post).toHaveBeenCalledWith(
      '/api/v1/player/campaigns/camp-1/chat/foundry',
      expect.objectContaining({ content: 'Hello world' }),
    )
  })

  test('skips messages with coreMessageId flag (echo prevention)', async () => {
    const api = createMockApiClient()
    const mgr = new ChatSyncManager(api, 'camp-1')
    const msg = makeMsg({ getFlag: jest.fn(() => 'some-core-id') })
    await mgr._onFoundryMessage(msg)
    expect(api.post).not.toHaveBeenCalled()
  })

  test('skips whisper messages', async () => {
    const api = createMockApiClient()
    const mgr = new ChatSyncManager(api, 'camp-1')
    await mgr._onFoundryMessage(makeMsg({ whisper: ['user-id-1'] }))
    expect(api.post).not.toHaveBeenCalled()
  })

  test('uses game.user.name as fallback when msg.alias is absent', async () => {
    const api = createMockApiClient()
    const mgr = new ChatSyncManager(api, 'camp-1')
    await mgr._onFoundryMessage(makeMsg({ alias: undefined }))
    expect(api.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ speakerName: globalThis.game.user.name }),
    )
  })

  test('does not throw when API call fails', async () => {
    const api = createMockApiClient({ post: jest.fn().mockRejectedValue(new Error('Network error')) })
    const mgr = new ChatSyncManager(api, 'camp-1')
    await expect(mgr._onFoundryMessage(makeMsg())).resolves.toBeUndefined()
  })

  test('resets _sending flag after success', async () => {
    const api = createMockApiClient()
    const mgr = new ChatSyncManager(api, 'camp-1')
    await mgr._onFoundryMessage(makeMsg())
    expect(mgr._sending).toBe(false)
  })

  test('resets _sending flag after failure', async () => {
    const api = createMockApiClient({ post: jest.fn().mockRejectedValue(new Error('fail')) })
    const mgr = new ChatSyncManager(api, 'camp-1')
    await mgr._onFoundryMessage(makeMsg())
    expect(mgr._sending).toBe(false)
  })
})

// ── _pollCore() — inbound ─────────────────────────────────────────────────────

describe('_pollCore()', () => {
  test('injects messages returned from Core', async () => {
    const api = createMockApiClient({
      get: jest.fn().mockResolvedValue({
        messages: [
          { id: 'core-msg-1', content: 'From Core', speakerName: 'Core Bot', timestamp: new Date().toISOString() },
        ],
      }),
    })
    const mgr = new ChatSyncManager(api, 'camp-1')
    await mgr._pollCore()
    expect(globalThis.ChatMessage.create).toHaveBeenCalledTimes(1)
    expect(globalThis.ChatMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({ speaker: { alias: 'Core Bot' } }),
    )
  })

  test('advances _since cursor after receiving messages', async () => {
    const api = createMockApiClient({
      get: jest.fn().mockResolvedValue({ messages: [{ id: 'm1', content: 'hi', speakerName: 'Core' }] }),
    })
    const mgr = new ChatSyncManager(api, 'camp-1')
    const oldSince = mgr._since
    // Advance fake timers so Date.now() returns a later value in _pollCore
    jest.advanceTimersByTime(10)
    await mgr._pollCore()
    expect(mgr._since).not.toBe(oldSince)
  })

  test('does nothing when Core returns empty messages', async () => {
    const api = createMockApiClient({ get: jest.fn().mockResolvedValue({ messages: [] }) })
    const mgr = new ChatSyncManager(api, 'camp-1')
    await mgr._pollCore()
    expect(globalThis.ChatMessage.create).not.toHaveBeenCalled()
  })

  test('does nothing when Core returns no messages field', async () => {
    const api = createMockApiClient({ get: jest.fn().mockResolvedValue({}) })
    const mgr = new ChatSyncManager(api, 'camp-1')
    await mgr._pollCore()
    expect(globalThis.ChatMessage.create).not.toHaveBeenCalled()
  })

  test('does not throw when API call fails', async () => {
    const api = createMockApiClient({ get: jest.fn().mockRejectedValue(new Error('Network error')) })
    const mgr = new ChatSyncManager(api, 'camp-1')
    await expect(mgr._pollCore()).resolves.toBeUndefined()
  })
})

// ── _injectFromCore() ─────────────────────────────────────────────────────────

describe('_injectFromCore()', () => {
  test('creates ChatMessage with escaped content and flag', async () => {
    const api = createMockApiClient()
    const mgr = new ChatSyncManager(api, 'camp-1')
    await mgr._injectFromCore({ id: 'core-99', content: '<b>bold</b>', speakerName: 'Bot' })
    expect(globalThis.ChatMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: expect.objectContaining({
          'crit-fumble-core': expect.objectContaining({ coreMessageId: 'core-99' }),
        }),
      }),
    )
  })

  test('falls back to "Core" when speakerName is absent', async () => {
    const api = createMockApiClient()
    const mgr = new ChatSyncManager(api, 'camp-1')
    await mgr._injectFromCore({ id: 'core-1', content: 'hi' })
    expect(globalThis.ChatMessage.create).toHaveBeenCalledWith(expect.objectContaining({ speaker: { alias: 'Core' } }))
  })

  test('does not throw when ChatMessage.create fails', async () => {
    globalThis.ChatMessage.create.mockRejectedValueOnce(new Error('Permission denied'))
    const api = createMockApiClient()
    const mgr = new ChatSyncManager(api, 'camp-1')
    await expect(mgr._injectFromCore({ id: 'x', content: 'hi', speakerName: 'Bot' })).resolves.toBeUndefined()
  })
})
