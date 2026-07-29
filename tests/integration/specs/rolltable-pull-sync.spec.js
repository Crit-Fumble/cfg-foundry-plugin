/**
 * RollTable write-back against a REAL FoundryVTT v14 world (dt#249).
 *
 * The unit tests assert we CALL Foundry correctly; only a real world tells us whether
 * Foundry AGREES — three silently-wrong writes have been caught this way and by nothing
 * else (fp#49 markers, dt#246 Scene.active, dt#247 embedded clock).
 *
 * What is genuinely rolltable-specific:
 *
 *   1. ONE embedded collection — `results` — where the table's content lives. This spec
 *      proves the engine reconciles it: rows the desired doc adds are CREATED (with their
 *      ids kept), rows it dropped are DELETED, and a doc that carries no `results` array
 *      leaves the world's rows completely alone.
 *   2. No `system` block and no top-level `type` — the simplest parent doc the engine
 *      has synced since Macro.
 *
 * Transport is stubbed, Foundry is real: the REAL RollTablePullSync runs a fixed plan.
 */

import { test, expect } from '@playwright/test'
import { ensureInGame } from '../shared/foundry-login.mjs'

const MODULE_URL = '/modules/crit-fumble-core/scripts/services/rolltable-pull-sync.js'

const TABLE_ID = 'CfgTableLiveTs01'

/** A plan item shaped exactly like getRollTableSyncPlanForWorld's output. */
function planItem(over = {}) {
  const { docData: docOver, ...rest } = over
  return {
    foundryRollTableId: TABLE_ID,
    everPushed: true, // a table always came FROM the world
    claimedAt: '2026-07-28T12:00:00.000Z',
    removedPaths: [],
    docData: {
      _id: TABLE_ID,
      name: 'Pocket Loot',
      formula: '1d2',
      results: [
        { _id: 'CfgResultLive001', type: 'text', text: 'A bent copper coin', range: [1, 1], weight: 1 },
        { _id: 'CfgResultLive002', type: 'text', text: 'A dead beetle', range: [2, 2], weight: 1 },
      ],
      ...docOver,
    },
    ...rest,
  }
}

/** Drive ONE real tick of the real service against the live world. */
async function runTick(page, plan) {
  return page.evaluate(
    async ({ plan, moduleUrl, tableId }) => {
      const { RollTablePullSync } = await import(moduleUrl)
      const acked = []
      const api = {
        getRollTableSyncPlan: async () => ({ data: plan }),
        ackRollTableSync: async (_inst, _world, results) => {
          acked.push(...results)
          return { data: { recorded: results.length } }
        },
      }
      await new RollTablePullSync(api, 'inst-live-test').tick()

      const doc = game.tables.get(tableId)
      return {
        acked,
        found: !!doc,
        id: doc?.id ?? null,
        name: doc?.name ?? null,
        formula: doc?.formula ?? null,
        results: doc ? doc.results.contents.map((r) => ({ id: r.id, text: r.text })) : null,
        createdAt: doc?._stats?.createdTime ?? null,
        count: game.tables.filter((t) => t.id === tableId).length,
      }
    },
    { plan, moduleUrl: MODULE_URL, tableId: TABLE_ID },
  )
}

async function seed(page, over = {}) {
  return page.evaluate(
    async ({ id, over }) => {
      for (const t of game.tables.filter((t) => t.id === id)) await t.delete()
      await RollTable.create(
        {
          _id: id,
          name: 'Pocket Loot',
          formula: '1d2',
          results: [
            { _id: 'CfgResultLive001', type: 'text', text: 'A bent copper coin', range: [1, 1], weight: 1 },
            { _id: 'CfgResultLive002', type: 'text', text: 'A dead beetle', range: [2, 2], weight: 1 },
          ],
          ...over,
        },
        { keepId: true },
      )
      return game.tables.get(id)?._stats?.createdTime ?? null
    },
    { id: TABLE_ID, over },
  )
}

async function cleanup(page) {
  await page.evaluate(async (id) => {
    for (const t of game.tables.filter((t) => t.id === id)) await t.delete()
  }, TABLE_ID)
}

test.describe('RollTable write-back against real Foundry', () => {
  test.beforeEach(async ({ page }) => {
    await ensureInGame(page)
    await page.waitForFunction(() => window.CFGCore && game?.ready, { timeout: 30_000 })
    await cleanup(page)
  })

  test.afterEach(async ({ page }) => {
    await cleanup(page)
  })

  test('carries a GM platform edit into the live world, results reconciled', async ({ page }) => {
    const createdBefore = await seed(page)
    // The platform edit: rename, change the die, EDIT row 1, DROP row 2, ADD row 3.
    const res = await runTick(page, [
      planItem({
        docData: {
          name: 'Pocket Loot (deluxe)',
          formula: '1d3',
          results: [
            { _id: 'CfgResultLive001', type: 'text', text: 'A gold coin (edited)', range: [1, 1], weight: 1 },
            { _id: 'CfgResultLive003', type: 'text', text: 'A silver button', range: [2, 3], weight: 1 },
          ],
        },
      }),
    ])

    expect(res.found).toBe(true)
    expect(res.name).toBe('Pocket Loot (deluxe)')
    expect(res.formula).toBe('1d3')
    // Reconciled by _id: edited in place, dropped, created (with its id kept).
    expect(res.results).toEqual([
      { id: 'CfgResultLive001', text: 'A gold coin (edited)' },
      { id: 'CfgResultLive003', text: 'A silver button' },
    ])
    // Same id AND same creation stamp ⇒ updated in place, not deleted and rebuilt.
    expect(res.createdAt).toBe(createdBefore)
    expect(res.count).toBe(1)
    expect(res.acked[0]).toMatchObject({ foundryRollTableId: TABLE_ID, ok: true, claimedAt: '2026-07-28T12:00:00.000Z' })
  })

  test('a doc WITHOUT a results array leaves the world rows alone', async ({ page }) => {
    await seed(page)
    const res = await runTick(page, [planItem({ docData: { name: 'Renamed only', results: undefined } })])

    expect(res.name).toBe('Renamed only')
    // Unmodeled collection untouched — absent means "not managed", never "delete all".
    expect(res.results).toHaveLength(2)
    expect(res.acked[0].ok).toBe(true)
  })

  test('reports world_deleted rather than re-creating a table the GM deleted', async ({ page }) => {
    // Nothing seeded — the table is absent and everPushed is true.
    const res = await runTick(page, [planItem()])

    expect(res.found).toBe(false)
    expect(res.acked[0]).toMatchObject({ ok: false, code: 'world_deleted' })
  })

  test('an empty plan does nothing and does not ack', async ({ page }) => {
    const res = await runTick(page, [])
    expect(res.acked).toEqual([])
  })
})
