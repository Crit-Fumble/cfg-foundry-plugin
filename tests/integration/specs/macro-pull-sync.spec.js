/**
 * Macro write-back against a REAL FoundryVTT v14 world (dt#245).
 *
 * The unit tests assert we CALL Foundry correctly; only a real world tells us whether
 * Foundry AGREES. That distinction is the whole reason this file exists — and it is not
 * theoretical: the actor work shipped two silently-wrong marker implementations that mocked
 * tests happily passed.
 *
 * What is genuinely macro-specific and could not be inferred from the actor sync:
 *
 *   1. `update({type})` script→chat WORKS on a Macro, where an Actor silently keeps its old
 *      type and needs delete+recreate. The adapter therefore sets `typeIsImmutable: false`,
 *      and this spec proves the document is UPDATED IN PLACE rather than destroyed and
 *      rebuilt — a recreate would drop anything holding a live reference.
 *   2. A Macro has no `system` block, so there is no foreign-system refusal to make.
 *   3. There are no embedded collections to reconcile.
 *
 * Transport is stubbed, Foundry is real: the REAL MacroPullSync runs against a fixed plan.
 */

import { test, expect } from '@playwright/test'
import { ensureInGame } from '../shared/foundry-login.mjs'

const MODULE_URL = '/modules/crit-fumble-core/scripts/services/macro-pull-sync.js'

const MACRO_ID = 'CfgMacroLiveTs01'

/** A plan item shaped exactly like getMacroSyncPlanForWorld's output. */
function planItem(over = {}) {
  const { docData: docOver, ...rest } = over
  return {
    foundryMacroId: MACRO_ID,
    everPushed: true, // a macro always came FROM the world
    claimedAt: '2026-07-25T12:00:00.000Z',
    removedPaths: [],
    docData: {
      _id: MACRO_ID,
      name: 'Rally the Troops',
      type: 'script',
      command: 'console.log("rally")',
      scope: 'global',
      ...docOver,
    },
    ...rest,
  }
}

/** Drive ONE real tick of the real service against the live world. */
async function runTick(page, plan) {
  return page.evaluate(
    async ({ plan, moduleUrl, macroId }) => {
      const { MacroPullSync } = await import(moduleUrl)
      const acked = []
      const api = {
        getMacroSyncPlan: async () => ({ data: plan }),
        ackMacroSync: async (_inst, _world, results) => {
          acked.push(...results)
          return { data: { recorded: results.length } }
        },
      }
      await new MacroPullSync(api, 'inst-live-test').tick()

      const doc = game.macros.get(macroId)
      return {
        acked,
        found: !!doc,
        id: doc?.id ?? null,
        name: doc?.name ?? null,
        type: doc?.type ?? null,
        command: doc?.command ?? null,
        // Same id AND same creation stamp ⇒ updated in place, not deleted and rebuilt.
        createdAt: doc?._stats?.createdTime ?? null,
        count: game.macros.filter((m) => m.id === macroId).length,
      }
    },
    { plan, moduleUrl: MODULE_URL, macroId: MACRO_ID },
  )
}

async function seed(page, over = {}) {
  return page.evaluate(
    async ({ id, over }) => {
      for (const m of game.macros.filter((m) => m.id === id)) await m.delete()
      await Macro.create(
        { _id: id, name: 'Rally the Troops', type: 'script', command: 'console.log("old")', scope: 'global', ...over },
        { keepId: true },
      )
      return game.macros.get(id)?._stats?.createdTime ?? null
    },
    { id: MACRO_ID, over },
  )
}

async function cleanup(page) {
  await page.evaluate(async (id) => {
    for (const m of game.macros.filter((m) => m.id === id)) await m.delete()
  }, MACRO_ID)
}

test.describe('Macro write-back against real Foundry', () => {
  test.beforeEach(async ({ page }) => {
    await ensureInGame(page)
    await page.waitForFunction(() => window.CFGCore && game?.ready, { timeout: 30_000 })
    await cleanup(page)
  })

  test.afterEach(async ({ page }) => {
    await cleanup(page)
  })

  test('carries a GM platform edit into the live world', async ({ page }) => {
    // The bug dt#245 closes: before this, the edit was claimed, held, then discarded.
    await seed(page)
    const res = await runTick(page, [planItem({ docData: { command: 'console.log("edited on the platform")' } })])

    expect(res.found).toBe(true)
    expect(res.command).toBe('console.log("edited on the platform")')
    expect(res.acked[0]).toMatchObject({ foundryMacroId: MACRO_ID, ok: true, claimedAt: '2026-07-25T12:00:00.000Z' })
  })

  test('changes type IN PLACE — no delete+recreate (typeIsImmutable: false)', async ({ page }) => {
    const createdBefore = await seed(page) // type: script
    const res = await runTick(page, [planItem({ docData: { type: 'chat', command: '/roll 1d20' } })])

    expect(res.type).toBe('chat')
    expect(res.command).toBe('/roll 1d20')
    expect(res.count).toBe(1)
    // The proof it was UPDATED, not rebuilt: a delete+create would mint a new creation
    // stamp even though keepId preserves the id.
    expect(res.createdAt).toBe(createdBefore)
  })

  test('reports world_deleted rather than re-creating a macro the GM deleted', async ({ page }) => {
    // Nothing seeded — the macro is absent and everPushed is true.
    const res = await runTick(page, [planItem()])

    expect(res.found).toBe(false)
    expect(res.acked[0]).toMatchObject({ ok: false, code: 'world_deleted' })
  })

  test('applies removedPaths under flags', async ({ page }) => {
    await seed(page, { flags: { playtable: { keep: 1, drop: 2 } } })
    const res = await runTick(page, [
      planItem({
        removedPaths: ['flags.playtable.drop'],
        docData: { flags: { playtable: { keep: 1 } } },
      }),
    ])

    const flags = await page.evaluate(
      (id) => foundry.utils.deepClone(game.macros.get(id)?.toObject()?.flags?.playtable ?? null),
      MACRO_ID,
    )
    expect(flags).toEqual({ keep: 1 })
    expect(res.acked[0].ok).toBe(true)
  })

  test('an empty plan does nothing and does not ack', async ({ page }) => {
    const res = await runTick(page, [])
    expect(res.acked).toEqual([])
  })
})
