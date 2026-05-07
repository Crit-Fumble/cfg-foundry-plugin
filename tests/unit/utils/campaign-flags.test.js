/**
 * CampaignFlags unit tests
 *
 * All tests use a plain object that mimics the Foundry Document flag API
 * (getFlag / setFlag / unsetFlag) so no Foundry runtime is needed.
 */

import { jest } from '@jest/globals'

let CampaignFlags
let CAMPAIGN_FLAG_NAMESPACE

beforeAll(async () => {
  const mod = await import('../../../scripts/utils/campaign-flags.js')
  CampaignFlags = mod.CampaignFlags
  CAMPAIGN_FLAG_NAMESPACE = mod.CAMPAIGN_FLAG_NAMESPACE
})

// ── Mock document factory ─────────────────────────────────────────────────────

function makeDoc(initialCampaigns = []) {
  const flags = { campaigns: [...initialCampaigns] }
  return {
    getFlag: jest.fn((_ns, key) => flags[key] ?? null),
    setFlag: jest.fn(async (_ns, key, value) => {
      flags[key] = value
    }),
    unsetFlag: jest.fn(async (_ns, key) => {
      delete flags[key]
    }),
    _flags: flags,
  }
}

function makeCampaignEntry(overrides = {}) {
  return { campaignId: 'camp-1', partyId: null, role: 'shared', addedAt: Date.now(), ...overrides }
}

// ── CAMPAIGN_FLAG_NAMESPACE ───────────────────────────────────────────────────

test('CAMPAIGN_FLAG_NAMESPACE is crit-fumble-core', () => {
  expect(CAMPAIGN_FLAG_NAMESPACE).toBe('crit-fumble-core')
})

// ── getCampaigns() ────────────────────────────────────────────────────────────

describe('getCampaigns()', () => {
  test('returns empty array for document with no flags', () => {
    const doc = makeDoc()
    doc.getFlag.mockReturnValue(null)
    expect(CampaignFlags.getCampaigns(doc)).toEqual([])
  })

  test('returns existing campaign associations', () => {
    const entry = makeCampaignEntry()
    const doc = makeDoc([entry])
    doc.getFlag.mockReturnValue([entry])
    expect(CampaignFlags.getCampaigns(doc)).toEqual([entry])
  })

  test('returns empty array for null/undefined document', () => {
    expect(CampaignFlags.getCampaigns(null)).toEqual([])
    expect(CampaignFlags.getCampaigns(undefined)).toEqual([])
  })

  test('returns empty array for document without getFlag', () => {
    expect(CampaignFlags.getCampaigns({})).toEqual([])
  })
})

// ── belongsToCampaign() ───────────────────────────────────────────────────────

describe('belongsToCampaign()', () => {
  test('returns true when campaign is in the flag list', () => {
    const doc = makeDoc()
    doc.getFlag.mockReturnValue([makeCampaignEntry({ campaignId: 'camp-1' })])
    expect(CampaignFlags.belongsToCampaign(doc, 'camp-1')).toBe(true)
  })

  test('returns false when campaign is not in the flag list', () => {
    const doc = makeDoc()
    doc.getFlag.mockReturnValue([makeCampaignEntry({ campaignId: 'camp-2' })])
    expect(CampaignFlags.belongsToCampaign(doc, 'camp-1')).toBe(false)
  })

  test('returns false for document with no campaigns', () => {
    const doc = makeDoc()
    doc.getFlag.mockReturnValue([])
    expect(CampaignFlags.belongsToCampaign(doc, 'camp-1')).toBe(false)
  })
})

// ── belongsToParty() ──────────────────────────────────────────────────────────

describe('belongsToParty()', () => {
  test('returns true when party ID matches', () => {
    const doc = makeDoc()
    doc.getFlag.mockReturnValue([makeCampaignEntry({ partyId: 'party-42' })])
    expect(CampaignFlags.belongsToParty(doc, 'party-42')).toBe(true)
  })

  test('returns false when party ID does not match', () => {
    const doc = makeDoc()
    doc.getFlag.mockReturnValue([makeCampaignEntry({ partyId: 'party-99' })])
    expect(CampaignFlags.belongsToParty(doc, 'party-42')).toBe(false)
  })
})

// ── getCampaignAssociation() ──────────────────────────────────────────────────

describe('getCampaignAssociation()', () => {
  test('returns the matching entry', () => {
    const entry = makeCampaignEntry({ campaignId: 'camp-1' })
    const doc = makeDoc()
    doc.getFlag.mockReturnValue([entry])
    expect(CampaignFlags.getCampaignAssociation(doc, 'camp-1')).toEqual(entry)
  })

  test('returns null when not found', () => {
    const doc = makeDoc()
    doc.getFlag.mockReturnValue([])
    expect(CampaignFlags.getCampaignAssociation(doc, 'camp-x')).toBeNull()
  })
})

// ── addToCampaign() ───────────────────────────────────────────────────────────

describe('addToCampaign()', () => {
  test('adds a new campaign association and returns true', async () => {
    const doc = makeDoc()
    doc.getFlag.mockReturnValue([])
    const result = await CampaignFlags.addToCampaign(doc, 'camp-1')
    expect(result).toBe(true)
    expect(doc.setFlag).toHaveBeenCalledWith(
      CAMPAIGN_FLAG_NAMESPACE,
      'campaigns',
      expect.arrayContaining([expect.objectContaining({ campaignId: 'camp-1' })]),
    )
  })

  test('defaults role to "shared"', async () => {
    const doc = makeDoc()
    doc.getFlag.mockReturnValue([])
    await CampaignFlags.addToCampaign(doc, 'camp-1')
    const saved = doc.setFlag.mock.calls[0][2]
    expect(saved[0].role).toBe('shared')
  })

  test('returns false when already in campaign with no option changes', async () => {
    const doc = makeDoc()
    doc.getFlag.mockReturnValue([makeCampaignEntry({ campaignId: 'camp-1' })])
    const result = await CampaignFlags.addToCampaign(doc, 'camp-1')
    expect(result).toBe(false)
    expect(doc.setFlag).not.toHaveBeenCalled()
  })

  test('updates existing association when partyId or role changes', async () => {
    const entry = makeCampaignEntry({ campaignId: 'camp-1', partyId: null })
    const doc = makeDoc()
    doc.getFlag.mockReturnValue([entry])
    const result = await CampaignFlags.addToCampaign(doc, 'camp-1', { partyId: 'party-99' })
    expect(result).toBe(true)
    const saved = doc.setFlag.mock.calls[0][2]
    expect(saved[0].partyId).toBe('party-99')
  })

  test('returns false for document without setFlag', async () => {
    const result = await CampaignFlags.addToCampaign({}, 'camp-1')
    expect(result).toBe(false)
  })
})

// ── removeFromCampaign() ──────────────────────────────────────────────────────

describe('removeFromCampaign()', () => {
  test('removes campaign and returns true', async () => {
    const doc = makeDoc()
    doc.getFlag.mockReturnValue([makeCampaignEntry({ campaignId: 'camp-1' })])
    const result = await CampaignFlags.removeFromCampaign(doc, 'camp-1')
    expect(result).toBe(true)
    const saved = doc.setFlag.mock.calls[0][2]
    expect(saved).toHaveLength(0)
  })

  test('returns false when campaign not found', async () => {
    const doc = makeDoc()
    doc.getFlag.mockReturnValue([])
    const result = await CampaignFlags.removeFromCampaign(doc, 'camp-x')
    expect(result).toBe(false)
    expect(doc.setFlag).not.toHaveBeenCalled()
  })
})

// ── setParty() ────────────────────────────────────────────────────────────────

describe('setParty()', () => {
  test('updates partyId on existing association', async () => {
    const entry = makeCampaignEntry({ campaignId: 'camp-1', partyId: null })
    const doc = makeDoc()
    doc.getFlag.mockReturnValue([entry])
    const result = await CampaignFlags.setParty(doc, 'camp-1', 'party-7')
    expect(result).toBe(true)
    const saved = doc.setFlag.mock.calls[0][2]
    expect(saved[0].partyId).toBe('party-7')
  })

  test('returns false when document is not in campaign', async () => {
    const doc = makeDoc()
    doc.getFlag.mockReturnValue([])
    const result = await CampaignFlags.setParty(doc, 'camp-1', 'party-7')
    expect(result).toBe(false)
  })
})

// ── clearCampaigns() ──────────────────────────────────────────────────────────

describe('clearCampaigns()', () => {
  test('sets campaigns flag to empty array', async () => {
    const doc = makeDoc()
    doc.getFlag.mockReturnValue([makeCampaignEntry()])
    await CampaignFlags.clearCampaigns(doc)
    expect(doc.setFlag).toHaveBeenCalledWith(CAMPAIGN_FLAG_NAMESPACE, 'campaigns', [])
  })
})

// ── Player associations ───────────────────────────────────────────────────────

describe('setPlayer() / getPlayerId() / getUserId()', () => {
  test('setPlayer stores playerId and userId flags', async () => {
    const actor = makeDoc()
    await CampaignFlags.setPlayer(actor, 'player-abc', 'user-xyz')
    expect(actor.setFlag).toHaveBeenCalledWith(CAMPAIGN_FLAG_NAMESPACE, 'playerId', 'player-abc')
    expect(actor.setFlag).toHaveBeenCalledWith(CAMPAIGN_FLAG_NAMESPACE, 'userId', 'user-xyz')
  })

  test('getPlayerId returns the stored value', () => {
    const actor = makeDoc()
    actor.getFlag.mockImplementation((_ns, key) => (key === 'playerId' ? 'player-abc' : null))
    expect(CampaignFlags.getPlayerId(actor)).toBe('player-abc')
  })

  test('getPlayerId returns null for actor without flag', () => {
    const actor = makeDoc()
    actor.getFlag.mockReturnValue(null)
    expect(CampaignFlags.getPlayerId(actor)).toBeNull()
  })

  test('getUserId returns the stored value', () => {
    const actor = makeDoc()
    actor.getFlag.mockImplementation((_ns, key) => (key === 'userId' ? 'user-xyz' : null))
    expect(CampaignFlags.getUserId(actor)).toBe('user-xyz')
  })
})

// ── findByCampaign() ──────────────────────────────────────────────────────────

describe('findByCampaign()', () => {
  test('returns only documents belonging to the campaign', () => {
    const docA = makeDoc()
    docA.getFlag.mockReturnValue([makeCampaignEntry({ campaignId: 'camp-1' })])
    const docB = makeDoc()
    docB.getFlag.mockReturnValue([makeCampaignEntry({ campaignId: 'camp-2' })])

    const collection = { filter: (fn) => [docA, docB].filter(fn) }
    const result = CampaignFlags.findByCampaign(collection, 'camp-1')
    expect(result).toEqual([docA])
  })
})

// ── getFiltered() ─────────────────────────────────────────────────────────────

describe('getFiltered()', () => {
  test('returns all contents when activeCampaignId is null', () => {
    const docs = [{}, {}]
    const collection = { contents: docs, filter: (fn) => docs.filter(fn) }
    expect(CampaignFlags.getFiltered(collection, null)).toEqual(docs)
  })

  test('includes unassigned documents in filtered results', () => {
    const unassigned = makeDoc()
    unassigned.getFlag.mockReturnValue([])
    const assigned = makeDoc()
    assigned.getFlag.mockReturnValue([makeCampaignEntry({ campaignId: 'camp-1' })])
    const other = makeDoc()
    other.getFlag.mockReturnValue([makeCampaignEntry({ campaignId: 'camp-2' })])

    const docs = [unassigned, assigned, other]
    const collection = { contents: docs, filter: (fn) => docs.filter(fn) }
    const result = CampaignFlags.getFiltered(collection, 'camp-1')
    expect(result).toContain(unassigned)
    expect(result).toContain(assigned)
    expect(result).not.toContain(other)
  })
})

// ── Batch operations ──────────────────────────────────────────────────────────

describe('addManyToCampaign() / removeManyFromCampaign()', () => {
  test('adds multiple documents and returns count', async () => {
    const docs = [makeDoc(), makeDoc(), makeDoc()]
    docs.forEach((d) => d.getFlag.mockReturnValue([]))
    const count = await CampaignFlags.addManyToCampaign(docs, 'camp-1')
    expect(count).toBe(3)
  })

  test('removes multiple documents and returns count', async () => {
    const entry = makeCampaignEntry({ campaignId: 'camp-1' })
    const docs = [makeDoc(), makeDoc()]
    docs.forEach((d) => d.getFlag.mockReturnValue([entry]))
    const count = await CampaignFlags.removeManyFromCampaign(docs, 'camp-1')
    expect(count).toBe(2)
  })
})
