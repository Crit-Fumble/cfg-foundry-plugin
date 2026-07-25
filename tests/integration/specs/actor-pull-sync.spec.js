/**
 * Actor pull-sync against a REAL FoundryVTT v14 world (fp#46).
 *
 * The unit tests assert we CALL Foundry correctly; they cannot tell us whether Foundry
 * AGREES — `Actor` is stubbed there, so a create that Foundry would reject still "passes".
 * Everything risky here is a contract with Foundry itself, and with the dnd5e system:
 *
 *   1. `{keepId: true}` really does preserve the server-assigned _id. If it didn't,
 *      `game.actors.get(id)` would never match and we'd create a duplicate actor every
 *      30s, forever. This is THE assertion the whole design rests on.
 *   2. A server-materialized actor doc VALIDATES against the real Actor schema AND the
 *      real dnd5e DataModel — `system` is system-defined, unlike a JournalEntry, so a
 *      shape mistake throws here and nowhere else.
 *   3. Items reconcile as embedded documents, including DELETES (a parent update merges
 *      and never removes).
 *   4. `update()` genuinely cannot change `type`, so the delete+recreate path is required
 *      rather than defensive.
 *
 * Transport is stubbed, Foundry is real: we construct the REAL ActorPullSync with a fake
 * api returning a fixed plan, then inspect the live world. That keeps this independent of
 * the Core stack — a failure means Foundry disagrees with us, not "fixtures aren't seeded".
 */

import { test, expect } from '@playwright/test'
import { ensureInGame } from '../shared/foundry-login.mjs'

const MODULE_URL = '/modules/crit-fumble-core/scripts/services/actor-pull-sync.js'

// Foundry's DocumentIdField requires exactly 16 alphanumerics — the same shape
// deriveFoundryEntryId emits server-side.
const ACTOR_ID = 'CfgActorLiveTs01'
const ITEM_A = 'CfgActorItemAA01'
const ITEM_B = 'CfgActorItemBB01'

/** A plan item shaped exactly like the server's buildActorSyncPlan output. */
function planItem(over = {}) {
  const { docData: docOver, ...rest } = over
  return {
    characterId: 'char_live_1',
    foundryActorId: ACTOR_ID,
    everPushed: false,
    systemId: 'dnd5e',
    claimedAt: null,
    docData: {
      _id: ACTOR_ID,
      name: 'Aria Brightwood',
      type: 'character',
      system: { attributes: { hp: { value: 11, max: 14 } } },
      items: [{ _id: ITEM_A, name: 'Dagger', type: 'weapon' }],
      ownership: { default: 0 },
      flags: { playtable: { sourceCharacterId: 'char_live_1' } },
      ...docOver,
    },
    ...rest,
  }
}

/** Drive ONE real tick of the real service against the live world. */
async function runTick(page, plan) {
  return page.evaluate(
    async ({ plan, moduleUrl, actorId }) => {
      const { ActorPullSync } = await import(moduleUrl)
      const acked = []
      const api = {
        getActorSyncPlan: async () => ({ data: plan }),
        ackActorSync: async (_inst, _world, _system, results) => {
          acked.push(...results)
          return { data: { recorded: results.length } }
        },
      }
      await new ActorPullSync(api, 'inst-live-test').tick()

      const doc = game.actors.get(actorId)
      // Read flags RAW, never via getFlag: Foundry validates the scope against active
      // module ids and our scope is `playtable` while the module id is
      // `crit-fumble-core` — getFlag THROWS.
      const sourceOf = (a) => a.flags?.playtable?.sourceCharacterId
      return {
        acked,
        found: !!doc,
        id: doc?.id ?? null,
        name: doc?.name ?? null,
        type: doc?.type ?? null,
        hp: doc ? foundry.utils.deepClone(doc.system?.attributes?.hp ?? null) : null,
        itemIds: doc ? doc.items.map((i) => i.id).sort() : [],
        itemNames: doc ? doc.items.map((i) => i.name).sort() : [],
        // How many actors carry our source flag — the DUPLICATE detector.
        sourceCount: game.actors.filter((a) => sourceOf(a) === 'char_live_1').length,
      }
    },
    { plan, moduleUrl: MODULE_URL, actorId: ACTOR_ID },
  )
}

async function cleanup(page) {
  await page.evaluate(async (id) => {
    for (const a of game.actors.filter((a) => a.id === id || a.flags?.playtable?.sourceCharacterId === 'char_live_1')) {
      await a.delete()
    }
  }, ACTOR_ID)
}

test.describe('Actor pull-sync against real Foundry', () => {
  test.beforeEach(async ({ page }) => {
    await ensureInGame(page)
    await page.waitForFunction(() => window.CFGCore && game?.ready, { timeout: 30_000 })
    await cleanup(page) // a prior failed run must not poison this one
  })

  test.afterEach(async ({ page }) => {
    await cleanup(page)
  })

  test('CREATES the actor under the assigned id — keepId holds against real Foundry', async ({ page }) => {
    const res = await runTick(page, [planItem()])

    // The load-bearing assertion. Foundry defaults keepId=false and DELETES _id
    // (common/abstract/document.mjs:483); if our option were dropped, this lookup would
    // miss and the actor would exist under a random id — duplicating every tick.
    expect(res.found).toBe(true)
    expect(res.id).toBe(ACTOR_ID)
    expect(res.name).toBe('Aria Brightwood')
    expect(res.type).toBe('character')
    // The doc validated against the REAL dnd5e DataModel, not a stub.
    expect(res.hp).toMatchObject({ value: 11, max: 14 })
    expect(res.itemIds).toEqual([ITEM_A])
    expect(res.acked[0]).toMatchObject({ characterId: 'char_live_1', foundryActorId: ACTOR_ID, ok: true })
  })

  test('a second tick UPDATES in place and never duplicates', async ({ page }) => {
    await runTick(page, [planItem()])
    const res = await runTick(page, [
      planItem({ everPushed: true, docData: { system: { attributes: { hp: { value: 3, max: 14 } } } } }),
    ])

    expect(res.sourceCount).toBe(1) // the duplicate detector
    expect(res.hp).toMatchObject({ value: 3 })
  })

  test('reconciles items — creates, and DELETES one the platform dropped', async ({ page }) => {
    await runTick(page, [
      planItem({
        docData: {
          items: [
            { _id: ITEM_A, name: 'Dagger', type: 'weapon' },
            { _id: ITEM_B, name: 'Shortbow', type: 'weapon' },
          ],
        },
      }),
    ])

    // Drop ITEM_A platform-side. A parent update() merges embedded collections and
    // never removes, so only explicit reconciliation can delete it.
    const res = await runTick(page, [
      planItem({ everPushed: true, docData: { items: [{ _id: ITEM_B, name: 'Shortbow', type: 'weapon' }] } }),
    ])

    expect(res.itemIds).toEqual([ITEM_B])
    expect(res.itemNames).toEqual(['Shortbow'])
  })

  test('recreates when the type changes — update() cannot do it', async ({ page }) => {
    await runTick(page, [planItem()]) // type: character
    const res = await runTick(page, [planItem({ everPushed: true, docData: { type: 'npc', system: {} } })])

    expect(res.found).toBe(true)
    expect(res.id).toBe(ACTOR_ID) // same id — keepId held across the recreate
    expect(res.type).toBe('npc')
    expect(res.sourceCount).toBe(1)
  })

  test('reports world_deleted rather than resurrecting a GM-deleted actor', async ({ page }) => {
    await runTick(page, [planItem()])
    await page.evaluate(async (id) => game.actors.get(id)?.delete(), ACTOR_ID)

    const res = await runTick(page, [planItem({ everPushed: true })])

    expect(res.found).toBe(false)
    expect(res.acked[0]).toMatchObject({ ok: false, code: 'world_deleted' })
  })

  test('refuses a doc built for another game system', async ({ page }) => {
    const res = await runTick(page, [planItem({ systemId: 'cyphersystem' })])

    expect(res.found).toBe(false)
    expect(res.acked[0]).toMatchObject({ ok: false, code: 'system_mismatch' })
  })
})
