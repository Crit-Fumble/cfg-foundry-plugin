/**
 * Core-hosted: Chat Sync integration tests
 *
 * Verifies ChatSyncManager lifecycle, outbound message forwarding, and
 * inbound injection via the Core chat API, using session cookie auth.
 *
 * Requires CORE_TEST_CAMPAIGN_ID to be set.
 */

import { test, expect } from '@playwright/test'

const CAMPAIGN_ID = process.env.CORE_TEST_CAMPAIGN_ID

test.describe('Core-hosted: Chat Sync', () => {
  test.skip(!CAMPAIGN_ID, 'Skipped: CORE_TEST_CAMPAIGN_ID not set')

  test.beforeEach(async ({ page }) => {
    await page.goto('/game')
    await page.waitForSelector('#sidebar', { timeout: 30_000 })
    await page.waitForFunction(() => window.game?.ready && window.CFGCore, { timeout: 30_000 })
  })

  // ── Module availability ───────────────────────────────────────────────────

  test('ChatSyncManager can be imported from the module', async ({ page }) => {
    const result = await page.evaluate(async () => {
      try {
        const { ChatSyncManager } = await import('/modules/crit-fumble-core/scripts/services/chat-sync.js')
        return { ok: typeof ChatSyncManager === 'function' }
      } catch (err) {
        return { error: err.message }
      }
    })
    expect(result.error ?? null).toBeNull()
    expect(result.ok).toBe(true)
  })

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  test('start() registers a createChatMessage hook', async ({ page }) => {
    const hookRegistered = await page.evaluate(
      async ([campaignId]) => {
        const { ChatSyncManager } = await import('/modules/crit-fumble-core/scripts/services/chat-sync.js')
        const api = window.CFGCore?.api
        if (!api) return false
        const mgr = new ChatSyncManager(api, campaignId)
        const before = game.hooks?.createChatMessage?.length ?? 0
        mgr.start()
        const after = game.hooks?.createChatMessage?.length ?? 0
        mgr.stop()
        // Hooks.on increments the handler list; even if we can't count precisely,
        // verify mgr._hookId is non-null after start()
        return mgr._hookId !== null || after > before
      },
      [CAMPAIGN_ID],
    )

    expect(hookRegistered).toBe(true)
  })

  test('stop() cleans up without errors', async ({ page }) => {
    const result = await page.evaluate(
      async ([campaignId]) => {
        try {
          const { ChatSyncManager } = await import('/modules/crit-fumble-core/scripts/services/chat-sync.js')
          const api = window.CFGCore?.api
          if (!api) return { error: 'no api' }
          const mgr = new ChatSyncManager(api, campaignId)
          mgr.start()
          mgr.stop()
          return { pollTimerNull: mgr._pollTimer === null, hookIdNull: mgr._hookId === null }
        } catch (err) {
          return { error: err.message }
        }
      },
      [CAMPAIGN_ID],
    )

    expect(result.error ?? null).toBeNull()
    expect(result.pollTimerNull).toBe(true)
    expect(result.hookIdNull).toBe(true)
  })

  test('stop() is safe to call before start()', async ({ page }) => {
    const result = await page.evaluate(
      async ([campaignId]) => {
        try {
          const { ChatSyncManager } = await import('/modules/crit-fumble-core/scripts/services/chat-sync.js')
          const api = window.CFGCore?.api
          if (!api) return { error: 'no api' }
          const mgr = new ChatSyncManager(api, campaignId)
          mgr.stop() // should not throw
          return { ok: true }
        } catch (err) {
          return { error: err.message }
        }
      },
      [CAMPAIGN_ID],
    )

    expect(result.error ?? null).toBeNull()
    expect(result.ok).toBe(true)
  })

  // ── Outbound (Foundry → Core) ─────────────────────────────────────────────

  test('_onFoundryMessage() posts to Core chat endpoint', async ({ page }) => {
    const result = await page.evaluate(
      async ([campaignId]) => {
        const calls = []
        // Spy on fetch to capture POST requests
        const origFetch = window.fetch
        window.fetch = function (url, opts = {}) {
          if (opts.method === 'POST' && String(url).includes('/chat')) {
            calls.push({ url: String(url), body: opts.body })
          }
          // Return a mock response so no actual network call is made
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ id: 'mock-msg-id' }),
            text: async () => '{}',
          })
        }
        try {
          const { ChatSyncManager } = await import('/modules/crit-fumble-core/scripts/services/chat-sync.js')
          const api = window.CFGCore?.api
          if (!api) return { error: 'no api' }
          const mgr = new ChatSyncManager(api, campaignId)
          const fakeMsg = {
            content: 'Integration test message',
            alias: 'Tester',
            timestamp: Date.now(),
            whisper: [],
            getFlag: () => null,
          }
          await mgr._onFoundryMessage(fakeMsg)
          return { calls }
        } finally {
          window.fetch = origFetch
        }
      },
      [CAMPAIGN_ID],
    )

    expect(result.error ?? null).toBeNull()
    expect(result.calls.length).toBeGreaterThanOrEqual(1)
    const bodyParsed = JSON.parse(result.calls[0].body)
    expect(bodyParsed.content).toBe('Integration test message')
    expect(bodyParsed.speakerName).toBe('Tester')
  })

  test('_onFoundryMessage() skips messages with coreMessageId flag', async ({ page }) => {
    const result = await page.evaluate(
      async ([campaignId]) => {
        const calls = []
        const origFetch = window.fetch
        window.fetch = function (url, opts = {}) {
          if (opts.method === 'POST' && String(url).includes('/chat')) calls.push(url)
          return Promise.resolve({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' })
        }
        try {
          const { ChatSyncManager } = await import('/modules/crit-fumble-core/scripts/services/chat-sync.js')
          const api = window.CFGCore?.api
          if (!api) return { error: 'no api' }
          const mgr = new ChatSyncManager(api, campaignId)
          const echoMsg = {
            content: 'Echo loop message',
            alias: 'Core Bot',
            timestamp: Date.now(),
            whisper: [],
            getFlag: () => 'some-core-message-id', // already has flag
          }
          await mgr._onFoundryMessage(echoMsg)
          return { calls }
        } finally {
          window.fetch = origFetch
        }
      },
      [CAMPAIGN_ID],
    )

    expect(result.error ?? null).toBeNull()
    expect(result.calls.length).toBe(0)
  })

  // ── Inbound injection (Core → Foundry) ────────────────────────────────────

  test('_injectFromCore() creates a ChatMessage with the coreMessageId flag', async ({ page }) => {
    const result = await page.evaluate(
      async ([campaignId]) => {
        const created = []
        const origCreate = ChatMessage.create
        ChatMessage.create = async function (data) {
          created.push(data)
          return { id: 'injected-msg', ...data }
        }
        try {
          const { ChatSyncManager } = await import('/modules/crit-fumble-core/scripts/services/chat-sync.js')
          const api = window.CFGCore?.api
          if (!api) return { error: 'no api' }
          const mgr = new ChatSyncManager(api, campaignId)
          await mgr._injectFromCore({ id: 'core-99', content: 'Hello from Core', speakerName: 'DM Bot' })
          return { created }
        } finally {
          ChatMessage.create = origCreate
        }
      },
      [CAMPAIGN_ID],
    )

    expect(result.error ?? null).toBeNull()
    expect(result.created.length).toBe(1)
    const msg = result.created[0]
    expect(msg.speaker?.alias).toBe('DM Bot')
    expect(msg.flags?.['crit-fumble-core']?.coreMessageId).toBe('core-99')
  })
})
