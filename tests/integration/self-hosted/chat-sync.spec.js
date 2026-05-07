/**
 * Self-hosted: Chat Sync integration tests
 *
 * Verifies ChatSyncManager outbound message forwarding includes the
 * Authorization Bearer header when running in self-hosted (API key) mode.
 *
 * Requires CORE_TEST_API_KEY and CORE_TEST_CAMPAIGN_ID to be set.
 */

import { test, expect } from '@playwright/test'

const API_KEY = process.env.CORE_TEST_API_KEY
const CAMPAIGN_ID = process.env.CORE_TEST_CAMPAIGN_ID

test.describe('Self-hosted: Chat Sync', () => {
  test.skip(!API_KEY || !CAMPAIGN_ID, 'Skipped: CORE_TEST_API_KEY and CORE_TEST_CAMPAIGN_ID required')

  test.beforeEach(async ({ page }) => {
    await page.goto('/game')
    await page.waitForSelector('#sidebar', { timeout: 30_000 })
    await page.waitForFunction(() => window.game?.ready && window.CFGCore, { timeout: 30_000 })
  })

  test('outbound message uses Bearer auth header in self-hosted mode', async ({ page }) => {
    const result = await page.evaluate(
      async ([campaignId, apiKey]) => {
        const authHeaders = []
        const origFetch = window.fetch
        window.fetch = function (url, opts = {}) {
          if (opts.method === 'POST' && String(url).includes('/chat')) {
            authHeaders.push(opts.headers?.Authorization ?? opts.headers?.authorization ?? null)
          }
          return Promise.resolve({ ok: true, status: 200, json: async () => ({ id: 'mock' }), text: async () => '{}' })
        }
        try {
          const { ChatSyncManager } = await import('/modules/crit-fumble-core/scripts/services/chat-sync.js')
          const { CoreAPIClient } = await import('/modules/crit-fumble-core/scripts/clients/api-client.js')
          const baseUrl = game.settings.get('crit-fumble-core', 'coreApiUrl')
          const api = new CoreAPIClient(baseUrl, apiKey)
          const mgr = new ChatSyncManager(api, campaignId)
          const fakeMsg = {
            content: 'Self-hosted chat test',
            alias: 'Tester',
            timestamp: Date.now(),
            whisper: [],
            getFlag: () => null,
          }
          await mgr._onFoundryMessage(fakeMsg)
          return { authHeaders }
        } finally {
          window.fetch = origFetch
        }
      },
      [CAMPAIGN_ID, API_KEY],
    )

    expect(result.error ?? null).toBeNull()
    expect(result.authHeaders.length).toBeGreaterThanOrEqual(1)
    expect(result.authHeaders[0]).toBe(`Bearer ${API_KEY}`)
  })

  test('_injectFromCore() creates ChatMessage regardless of auth mode', async ({ page }) => {
    const result = await page.evaluate(
      async ([campaignId, apiKey]) => {
        const created = []
        const origCreate = ChatMessage.create
        ChatMessage.create = async function (data) {
          created.push(data)
          return { id: 'injected', ...data }
        }
        try {
          const { ChatSyncManager } = await import('/modules/crit-fumble-core/scripts/services/chat-sync.js')
          const { CoreAPIClient } = await import('/modules/crit-fumble-core/scripts/clients/api-client.js')
          const baseUrl = game.settings.get('crit-fumble-core', 'coreApiUrl')
          const api = new CoreAPIClient(baseUrl, apiKey)
          const mgr = new ChatSyncManager(api, campaignId)
          await mgr._injectFromCore({ id: 'core-sh-1', content: 'Hello', speakerName: 'Core Bot' })
          return { created }
        } finally {
          ChatMessage.create = origCreate
        }
      },
      [CAMPAIGN_ID, API_KEY],
    )

    expect(result.error ?? null).toBeNull()
    expect(result.created.length).toBe(1)
    expect(result.created[0].flags?.['crit-fumble-core']?.coreMessageId).toBe('core-sh-1')
  })
})
