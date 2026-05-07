/**
 * QuestSyncManager unit tests
 *
 * Covers initialization, folder creation, quest fetching, and error handling.
 * Quest-to-journal mapping is integration territory; unit tests focus on
 * the state management and API interaction contract.
 */

import { jest } from '@jest/globals'
import { createMockApiClient } from '../../mocks/api-client.js'

let QuestSyncManager

beforeAll(async () => {
  // QuestSyncManager uses game.folders and Folder.create — set them up here
  globalThis.game.folders = { find: jest.fn(() => null) }
  globalThis.Folder = {
    create: jest.fn(async (data) => ({ id: 'folder-id', ...data })),
  }

  const mod = await import('../../../scripts/services/quest-sync.js')
  QuestSyncManager = mod.QuestSyncManager
})

beforeEach(() => {
  jest.clearAllMocks()
  globalThis.game.folders.find.mockReturnValue(null) // no existing folder by default
  globalThis.game.settings.get.mockImplementation((_mod, key) => {
    if (key === 'campaignId') return 'test-campaign-id'
    return null
  })
})

// ── Constructor ───────────────────────────────────────────────────────────────

describe('constructor', () => {
  test('stores apiClient and partyContext', () => {
    const api = createMockApiClient()
    const mgr = new QuestSyncManager(api, null)
    expect(mgr.apiClient).toBe(api)
    expect(mgr.partyContext).toBeNull()
  })

  test('initialises with empty quests and no folder', () => {
    const mgr = new QuestSyncManager(createMockApiClient(), null)
    expect(mgr.quests).toEqual([])
    expect(mgr.questFolder).toBeNull()
  })
})

// ── initialize() ─────────────────────────────────────────────────────────────

describe('initialize()', () => {
  test('skips when no campaignId is configured', async () => {
    globalThis.game.settings.get.mockReturnValue(null)
    const api = createMockApiClient()
    const mgr = new QuestSyncManager(api, null)
    await mgr.initialize()
    expect(api.getQuests).not.toHaveBeenCalled()
  })

  test('creates quest folder when none exists', async () => {
    const api = createMockApiClient({
      getQuests: jest.fn().mockResolvedValue({ quests: [] }),
    })
    const mgr = new QuestSyncManager(api, null)
    // Mock journal methods to avoid errors in syncQuestToJournal
    jest.spyOn(mgr, 'syncQuestToJournal').mockResolvedValue(undefined)
    jest.spyOn(mgr, 'cleanupDeletedQuests').mockResolvedValue(undefined)

    await mgr.initialize()

    expect(globalThis.Folder.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Quest Log', type: 'JournalEntry' }),
    )
  })

  test('reuses existing quest folder when found', async () => {
    const existingFolder = { id: 'existing-folder', name: 'Quest Log' }
    globalThis.game.folders.find.mockReturnValue(existingFolder)

    const api = createMockApiClient({
      getQuests: jest.fn().mockResolvedValue({ quests: [] }),
    })
    const mgr = new QuestSyncManager(api, null)
    jest.spyOn(mgr, 'syncQuestToJournal').mockResolvedValue(undefined)
    jest.spyOn(mgr, 'cleanupDeletedQuests').mockResolvedValue(undefined)

    await mgr.initialize()

    expect(globalThis.Folder.create).not.toHaveBeenCalled()
    expect(mgr.questFolder).toBe(existingFolder)
  })

  test('fetches quests from Core API with campaignId', async () => {
    const api = createMockApiClient({
      getQuests: jest.fn().mockResolvedValue({ quests: [{ id: 'q1', title: 'Find the orb' }] }),
    })
    const mgr = new QuestSyncManager(api, null)
    jest.spyOn(mgr, 'syncQuestToJournal').mockResolvedValue(undefined)
    jest.spyOn(mgr, 'cleanupDeletedQuests').mockResolvedValue(undefined)

    await mgr.initialize()

    expect(api.getQuests).toHaveBeenCalledWith('test-campaign-id', expect.any(Object))
    expect(mgr.quests).toHaveLength(1)
  })

  test('shows warning notification on API failure', async () => {
    const api = createMockApiClient({
      getQuests: jest.fn().mockRejectedValue(new Error('Unreachable')),
    })
    const mgr = new QuestSyncManager(api, null)

    await mgr.initialize()

    expect(globalThis.ui.notifications.warn).toHaveBeenCalled()
  })

  test('does not throw on failure', async () => {
    const api = createMockApiClient({
      getQuests: jest.fn().mockRejectedValue(new Error('fail')),
    })
    const mgr = new QuestSyncManager(api, null)
    await expect(mgr.initialize()).resolves.toBeUndefined()
  })
})

// ── syncQuests() ──────────────────────────────────────────────────────────────

describe('syncQuests()', () => {
  test('passes partyId from partyContext when available', async () => {
    const api = createMockApiClient({
      getQuests: jest.fn().mockResolvedValue({ quests: [] }),
    })
    const partyContext = { getActivePartyId: jest.fn(() => 'party-abc') }
    const mgr = new QuestSyncManager(api, partyContext)
    jest.spyOn(mgr, 'syncQuestToJournal').mockResolvedValue(undefined)
    jest.spyOn(mgr, 'cleanupDeletedQuests').mockResolvedValue(undefined)

    await mgr.syncQuests('camp-1')

    expect(api.getQuests).toHaveBeenCalledWith('camp-1', expect.objectContaining({ partyId: 'party-abc' }))
  })

  test('handles missing partyContext gracefully', async () => {
    const api = createMockApiClient({
      getQuests: jest.fn().mockResolvedValue({ quests: [] }),
    })
    const mgr = new QuestSyncManager(api, null)
    jest.spyOn(mgr, 'syncQuestToJournal').mockResolvedValue(undefined)
    jest.spyOn(mgr, 'cleanupDeletedQuests').mockResolvedValue(undefined)

    await expect(mgr.syncQuests('camp-1')).resolves.toBeUndefined()
    expect(api.getQuests).toHaveBeenCalledWith('camp-1', expect.objectContaining({ partyId: undefined }))
  })

  test('stores returned quests in this.quests', async () => {
    const quests = [{ id: 'q1' }, { id: 'q2' }]
    const api = createMockApiClient({ getQuests: jest.fn().mockResolvedValue({ quests }) })
    const mgr = new QuestSyncManager(api, null)
    jest.spyOn(mgr, 'syncQuestToJournal').mockResolvedValue(undefined)
    jest.spyOn(mgr, 'cleanupDeletedQuests').mockResolvedValue(undefined)

    await mgr.syncQuests('camp-1')
    expect(mgr.quests).toEqual(quests)
  })
})
