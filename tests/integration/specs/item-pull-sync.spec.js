/**
 * Standalone Item write-back against a REAL FoundryVTT v14 world (dt#250).
 *
 * What is genuinely item-specific:
 *
 *   1. The embedded collection is `effects` — the engine reconciles it: effects the
 *      desired doc adds are CREATED (ids kept), effects it dropped are DELETED, and a
 *      doc without an `effects` array leaves the world's effects alone.
 *   2. `update({type})` SILENTLY KEEPS the old type (measured 2026-07-29 — the Actor
 *      case), so the engine's default delete+recreate branch must fire on weapon→loot.
 *   3. Items carry a dnd5e `system` block; unknown keys are DISCARDED on write and
 *      `system.-=` markers silently ignored (measured) — the doc round-trips through
 *      the DataModel.
 *
 * Transport is stubbed, Foundry is real: the REAL ItemPullSync runs a fixed plan.
 */

import { test, expect } from '@playwright/test'
import { ensureInGame } from '../shared/foundry-login.mjs'

const MODULE_URL = '/modules/crit-fumble-core/scripts/services/item-pull-sync.js'

const ITEM_ID = 'CfgItemLiveTs001'

/** A plan item shaped exactly like getItemSyncPlanForWorld's output. */
function planItem(over = {}) {
  const { docData: docOver, ...rest } = over
  return {
    foundryItemId: ITEM_ID,
    everPushed: true, // an item always came FROM the world
    claimedAt: '2026-07-29T12:00:00.000Z',
    removedPaths: [],
    docData: {
      _id: ITEM_ID,
      name: 'Live Blade',
      type: 'weapon',
      img: 'icons/svg/sword.svg',
      system: { quantity: 1 },
      effects: [
        { _id: 'CfgItemFxLive001', name: 'Keen edge', disabled: false },
        { _id: 'CfgItemFxLive002', name: 'Glow', disabled: true },
      ],
      ...docOver,
    },
    ...rest,
  }
}

/** Drive ONE real tick of the real service against the live world. */
async function runTick(page, plan) {
  return page.evaluate(
    async ({ plan, moduleUrl, itemId }) => {
      const { ItemPullSync } = await import(moduleUrl)
      const acked = []
      const api = {
        getItemSyncPlan: async () => ({ data: plan }),
        ackItemSync: async (_inst, _world, results) => {
          acked.push(...results)
          return { data: { recorded: results.length } }
        },
      }
      await new ItemPullSync(api, 'inst-live-test').tick()

      const doc = game.items.get(itemId)
      const src = doc?.toObject() ?? null
      return {
        acked,
        found: !!doc,
        name: src?.name ?? null,
        type: src?.type ?? null,
        quantity: src?.system?.quantity ?? null,
        effects: doc ? doc.effects.contents.map((e) => ({ id: e.id, name: e.name })) : null,
        createdAt: doc?._stats?.createdTime ?? null,
        count: game.items.filter((i) => i.id === itemId).length,
      }
    },
    { plan, moduleUrl: MODULE_URL, itemId: ITEM_ID },
  )
}

async function seed(page, over = {}) {
  return page.evaluate(
    async ({ id, over }) => {
      for (const i of game.items.filter((i) => i.id === id)) await i.delete()
      await Item.create(
        {
          _id: id,
          name: 'Live Blade',
          type: 'weapon',
          img: 'icons/svg/sword.svg',
          system: { quantity: 1 },
          effects: [
            { _id: 'CfgItemFxLive001', name: 'Keen edge', disabled: false },
            { _id: 'CfgItemFxLive002', name: 'Glow', disabled: true },
          ],
          ...over,
        },
        { keepId: true },
      )
      return game.items.get(id)?._stats?.createdTime ?? null
    },
    { id: ITEM_ID, over },
  )
}

async function cleanup(page) {
  await page.evaluate(async (id) => {
    for (const i of game.items.filter((i) => i.id === id)) await i.delete()
  }, ITEM_ID)
}

test.describe('Standalone Item write-back against real Foundry', () => {
  test.beforeEach(async ({ page }) => {
    await ensureInGame(page)
    await page.waitForFunction(() => window.CFGCore && game?.ready, { timeout: 30_000 })
    await cleanup(page)
  })

  test.afterEach(async ({ page }) => {
    await cleanup(page)
  })

  test('carries a GM platform edit into the live world, effects reconciled', async ({ page }) => {
    const createdBefore = await seed(page)
    // The platform edit: rename, bump quantity, EDIT effect 1, DROP effect 2, ADD effect 3.
    const res = await runTick(page, [
      planItem({
        docData: {
          name: 'Live Blade (deluxe)',
          system: { quantity: 3 },
          effects: [
            { _id: 'CfgItemFxLive001', name: 'Keen edge (honed)', disabled: false },
            { _id: 'CfgItemFxLive003', name: 'Flame', disabled: false },
          ],
        },
      }),
    ])

    expect(res.found).toBe(true)
    expect(res.name).toBe('Live Blade (deluxe)')
    expect(res.quantity).toBe(3)
    // Reconciled by _id: edited in place, dropped, created (with its id kept).
    expect(res.effects).toEqual([
      { id: 'CfgItemFxLive001', name: 'Keen edge (honed)' },
      { id: 'CfgItemFxLive003', name: 'Flame' },
    ])
    // Same id AND same creation stamp ⇒ updated in place, not deleted and rebuilt.
    expect(res.createdAt).toBe(createdBefore)
    expect(res.count).toBe(1)
    expect(res.acked[0]).toMatchObject({ foundryItemId: ITEM_ID, ok: true, claimedAt: '2026-07-29T12:00:00.000Z' })
  })

  test('a doc WITHOUT an effects array leaves the world effects alone', async ({ page }) => {
    await seed(page)
    const res = await runTick(page, [planItem({ docData: { name: 'Renamed only', effects: undefined } })])

    expect(res.name).toBe('Renamed only')
    // Unmodeled collection untouched — absent means "not managed", never "delete all".
    expect(res.effects).toHaveLength(2)
    expect(res.acked[0].ok).toBe(true)
  })

  test('a TYPE change delete+recreates with the id kept (update({type}) is a silent no-op)', async ({ page }) => {
    const createdBefore = await seed(page)
    const res = await runTick(page, [planItem({ docData: { type: 'loot', system: {}, effects: [] } })])

    expect(res.found).toBe(true)
    expect(res.type).toBe('loot')
    // Recreated, not updated: same id, NEW creation stamp — the only honest path,
    // since a plain update would silently keep 'weapon' (measured).
    expect(res.createdAt).not.toBe(createdBefore)
    expect(res.count).toBe(1)
    expect(res.acked[0].ok).toBe(true)
  })

  test('reports world_deleted rather than re-creating an item the GM deleted', async ({ page }) => {
    // Nothing seeded — the item is absent and everPushed is true.
    const res = await runTick(page, [planItem()])
    expect(res.found).toBe(false)
    expect(res.acked[0]).toMatchObject({ ok: false, code: 'world_deleted' })
  })

  test('an empty plan does nothing and does not ack', async ({ page }) => {
    const res = await runTick(page, [])
    expect(res.acked).toEqual([])
  })
})
