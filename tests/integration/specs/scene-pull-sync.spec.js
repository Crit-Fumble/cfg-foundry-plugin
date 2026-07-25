/**
 * Scene sync against a REAL FoundryVTT v14 world (dt#246).
 *
 * Scenes are the riskiest entity in the programme, and for reasons only a live world can
 * settle:
 *
 *   1. NINE embedded collections. A parent update merges them by `_id` and never removes,
 *      so tokens/walls/lights must be reconciled explicitly — and a collection the platform
 *      does NOT model must be left completely alone rather than emptied.
 *   2. The ACTIVE scene. Players are looking at it. Updating it must not deactivate it,
 *      throw, or move the canvas.
 *   3. `active` is writable through a plain `update()`. The server strips it; this proves
 *      the plugin never smuggles it back in and change which scene players are on.
 *
 * Transport is stubbed, Foundry is real.
 */

import { test, expect } from '@playwright/test'
import { ensureInGame } from '../shared/foundry-login.mjs'

const MODULE_URL = '/modules/crit-fumble-core/scripts/services/scene-pull-sync.js'

const SCENE_ID = 'CfgSceneLiveTs01'
const TOKEN_A = 'CfgSceneTokenA01'
const TOKEN_B = 'CfgSceneTokenB01'

function planItem(over = {}) {
  const { docData: docOver, ...rest } = over
  return {
    sceneId: 'loc_scene_live_1',
    foundrySceneId: SCENE_ID,
    everPushed: false,
    claimedAt: null,
    removedPaths: [],
    docData: {
      _id: SCENE_ID,
      name: 'Sunken Vault',
      width: 2000,
      height: 2000,
      ownership: { default: 0 },
      flags: { playtable: { sourceSceneId: 'loc_scene_live_1' } },
      ...docOver,
    },
    ...rest,
  }
}

async function runTick(page, plan) {
  return page.evaluate(
    async ({ plan, moduleUrl, sceneId }) => {
      const { ScenePullSync } = await import(moduleUrl)
      const acked = []
      const api = {
        getSceneSyncPlan: async () => ({ data: plan }),
        ackSceneSync: async (_inst, _world, results) => {
          acked.push(...results)
          return { data: { recorded: results.length } }
        },
      }
      await new ScenePullSync(api, 'inst-live-test').tick()

      const doc = game.scenes.get(sceneId)
      const ids = (c) => (c ? [...c].map((d) => d.id).sort() : [])
      return {
        acked,
        found: !!doc,
        id: doc?.id ?? null,
        name: doc?.name ?? null,
        active: doc?.active ?? null,
        width: doc?.width ?? null,
        tokenIds: ids(doc?.tokens),
        wallCount: doc?.walls?.size ?? 0,
        count: game.scenes.filter((s) => s.id === sceneId).length,
      }
    },
    { plan, moduleUrl: MODULE_URL, sceneId: SCENE_ID },
  )
}

async function cleanup(page) {
  await page.evaluate(async (id) => {
    for (const s of game.scenes.filter((s) => s.id === id)) {
      if (s.active) {
        const other = game.scenes.find((x) => x.id !== id)
        if (other) await other.activate()
      }
      await s.delete()
    }
  }, SCENE_ID)
}

test.describe('Scene sync against real Foundry', () => {
  test.beforeEach(async ({ page }) => {
    await ensureInGame(page)
    await page.waitForFunction(() => window.CFGCore && game?.ready, { timeout: 30_000 })
    await cleanup(page)
  })

  test.afterEach(async ({ page }) => {
    await cleanup(page)
  })

  test('CREATES a platform scene under the assigned id — keepId holds', async ({ page }) => {
    const res = await runTick(page, [planItem()])

    expect(res.found).toBe(true)
    expect(res.id).toBe(SCENE_ID)
    expect(res.name).toBe('Sunken Vault')
    expect(res.width).toBe(2000)
    expect(res.acked[0]).toMatchObject({ sceneId: 'loc_scene_live_1', foundrySceneId: SCENE_ID, ok: true })
  })

  test('reconciles TOKENS — creates, then deletes one the platform dropped', async ({ page }) => {
    await runTick(page, [
      planItem({
        docData: {
          tokens: [
            { _id: TOKEN_A, name: 'Tok A', x: 100, y: 100 },
            { _id: TOKEN_B, name: 'Tok B', x: 200, y: 200 },
          ],
        },
      }),
    ])

    const res = await runTick(page, [
      planItem({ everPushed: true, docData: { tokens: [{ _id: TOKEN_B, name: 'Tok B', x: 200, y: 200 }] } }),
    ])

    // A parent update merges embedded docs and never removes — only explicit
    // reconciliation can delete TOKEN_A.
    expect(res.tokenIds).toEqual([TOKEN_B])
  })

  test('leaves a collection the platform does NOT model completely alone', async ({ page }) => {
    // The dangerous inverse of reconciliation: if `walls` being absent from the desired doc
    // were read as "no walls", a platform scene that doesn't model walls would silently
    // erase the GM's wall layer.
    await runTick(page, [planItem()])
    await page.evaluate(
      async ({ id }) => {
        await game.scenes
          .get(id)
          .createEmbeddedDocuments('Wall', [{ c: [0, 0, 100, 100] }])
      },
      { id: SCENE_ID },
    )

    const res = await runTick(page, [planItem({ everPushed: true, docData: { name: 'Renamed' } })])

    expect(res.name).toBe('Renamed')
    expect(res.wallCount).toBe(1) // untouched
  })

  test('updating the ACTIVE scene keeps it active and does not move the canvas', async ({ page }) => {
    await runTick(page, [planItem()])
    await page.evaluate(async (id) => game.scenes.get(id)?.activate(), SCENE_ID)

    const res = await runTick(page, [planItem({ everPushed: true, docData: { name: 'Renamed While Live' } })])

    expect(res.name).toBe('Renamed While Live')
    expect(res.active).toBe(true) // still the players' scene
    const canvasSceneId = await page.evaluate(() => canvas?.scene?.id ?? null)
    expect(canvasSceneId).toBe(SCENE_ID)
  })

  test('never activates a scene, even if a doc smuggles active: true', async ({ page }) => {
    // The server strips `active`; this is the belt-and-braces proof that a doc carrying it
    // cannot yank every connected player onto this scene.
    const otherActiveBefore = await page.evaluate(() => game.scenes.find((s) => s.active)?.id ?? null)

    await runTick(page, [planItem({ docData: { active: true } })])

    const state = await page.evaluate(
      (id) => ({ thisActive: game.scenes.get(id)?.active ?? null, activeId: game.scenes.find((s) => s.active)?.id ?? null }),
      SCENE_ID,
    )
    // Whatever was active before is still active — we did not steal it.
    expect(state.activeId).toBe(otherActiveBefore)
    expect(state.thisActive).toBe(false)
  })

  test('reports world_deleted rather than re-creating a scene the GM deleted', async ({ page }) => {
    const res = await runTick(page, [planItem({ everPushed: true })])
    expect(res.found).toBe(false)
    expect(res.acked[0]).toMatchObject({ ok: false, code: 'world_deleted' })
  })
})
