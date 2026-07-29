/**
 * Cards write-back against a REAL FoundryVTT v14 world (dt#249).
 *
 * What is genuinely cards-specific and MUST be proven live:
 *
 *   1. A type change (deck→hand) goes through DELETE + CREATE — the dt#249 probe
 *      measured `update({type})` silently keeps the old type (the Actor behavior), so
 *      the engine's default `typeIsImmutable: true` must actually fire and produce a
 *      document of the NEW type.
 *   2. The embedded `cards` collection reconciles by _id.
 *
 * Transport is stubbed, Foundry is real.
 */

import { test, expect } from '@playwright/test'
import { ensureInGame } from '../shared/foundry-login.mjs'

const MODULE_URL = '/modules/crit-fumble-core/scripts/services/cards-pull-sync.js'

const STACK_ID = 'CfgCardsLiveTs01'

function planItem(over = {}) {
  const { docData: docOver, ...rest } = over
  return {
    foundryCardsId: STACK_ID,
    everPushed: true,
    claimedAt: '2026-07-28T12:00:00.000Z',
    removedPaths: [],
    docData: {
      _id: STACK_ID,
      name: 'Tarot Deck',
      type: 'deck',
      cards: [
        { _id: 'CfgCardLive00001', name: 'The Fool', type: 'base', value: 0, sort: 1 },
        { _id: 'CfgCardLive00002', name: 'The Magician', type: 'base', value: 1, sort: 2 },
      ],
      ...docOver,
    },
    ...rest,
  }
}

async function runTick(page, plan) {
  return page.evaluate(
    async ({ plan, moduleUrl, stackId }) => {
      const { CardsPullSync } = await import(moduleUrl)
      const acked = []
      const api = {
        getCardsSyncPlan: async () => ({ data: plan }),
        ackCardsSync: async (_inst, _world, results) => {
          acked.push(...results)
          return { data: { recorded: results.length } }
        },
      }
      await new CardsPullSync(api, 'inst-live-test').tick()

      const doc = game.cards.get(stackId)
      return {
        acked,
        found: !!doc,
        name: doc?.name ?? null,
        type: doc?.type ?? null,
        // Read SOURCE data, not `c.name` — Card#name is a live-measured GETTER that
        // derives from the current face and falls back to "Unknown (<parent>)" for a
        // faceless card. The written doc is under _source; the getter is display-only.
        cards: doc ? doc.cards.contents.map((c) => ({ id: c.id, name: c.toObject().name })) : null,
        createdAt: doc?._stats?.createdTime ?? null,
        count: game.cards.filter((c) => c.id === stackId).length,
      }
    },
    { plan, moduleUrl: MODULE_URL, stackId: STACK_ID },
  )
}

async function seed(page, over = {}) {
  return page.evaluate(
    async ({ id, over }) => {
      for (const c of game.cards.filter((c) => c.id === id)) await c.delete()
      await Cards.create(
        {
          _id: id,
          name: 'Tarot Deck',
          type: 'deck',
          cards: [
            { _id: 'CfgCardLive00001', name: 'The Fool', type: 'base', value: 0, sort: 1 },
            { _id: 'CfgCardLive00002', name: 'The Magician', type: 'base', value: 1, sort: 2 },
          ],
          ...over,
        },
        { keepId: true },
      )
      return game.cards.get(id)?._stats?.createdTime ?? null
    },
    { id: STACK_ID, over },
  )
}

async function cleanup(page) {
  await page.evaluate(async (id) => {
    for (const c of game.cards.filter((c) => c.id === id)) await c.delete()
  }, STACK_ID)
}

test.describe('Cards write-back against real Foundry', () => {
  test.beforeEach(async ({ page }) => {
    await ensureInGame(page)
    await page.waitForFunction(() => window.CFGCore && game?.ready, { timeout: 30_000 })
    await cleanup(page)
  })

  test.afterEach(async ({ page }) => {
    await cleanup(page)
  })

  test('carries a GM platform edit into the live world, cards reconciled', async ({ page }) => {
    const createdBefore = await seed(page)
    const res = await runTick(page, [
      planItem({
        docData: {
          name: 'Tarot (trimmed)',
          cards: [
            { _id: 'CfgCardLive00001', name: 'The Fool (reversed)', type: 'base', value: 0, sort: 1 },
            { _id: 'CfgCardLive00003', name: 'The Empress', type: 'base', value: 3, sort: 3 },
          ],
        },
      }),
    ])

    expect(res.name).toBe('Tarot (trimmed)')
    expect(res.cards).toEqual([
      { id: 'CfgCardLive00001', name: 'The Fool (reversed)' },
      { id: 'CfgCardLive00003', name: 'The Empress' },
    ])
    expect(res.createdAt).toBe(createdBefore) // same type → updated in place
    expect(res.count).toBe(1)
    expect(res.acked[0]).toMatchObject({ foundryCardsId: STACK_ID, ok: true })
  })

  test('a type change deck→hand goes through delete+recreate and the NEW type wins', async ({ page }) => {
    // Probe-measured: update({type}) silently keeps 'deck'. Only the engine's
    // delete+recreate branch can change it — proven by the fresh creation stamp.
    const createdBefore = await seed(page) // type: deck
    const res = await runTick(page, [planItem({ docData: { type: 'hand', cards: [] } })])

    expect(res.type).toBe('hand')
    expect(res.count).toBe(1)
    expect(res.createdAt).not.toBe(createdBefore) // recreated, not silently ignored
    expect(res.acked[0].ok).toBe(true)
  })

  test('reports world_deleted rather than re-creating a stack the GM deleted', async ({ page }) => {
    const res = await runTick(page, [planItem()])
    expect(res.found).toBe(false)
    expect(res.acked[0]).toMatchObject({ ok: false, code: 'world_deleted' })
  })
})
