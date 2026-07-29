/**
 * Folder write-back against a REAL FoundryVTT v14 world (dt#250 slice 2).
 *
 * The unit tests assert we CALL Foundry correctly; only a real world tells us whether
 * Foundry AGREES. The dt#250 probe measured (v14.361, dnd5e):
 *
 *   · create `{keepId: true}` keeps the id; every folder field lands
 *   · `update({folder: null})` and `update({color: null})` genuinely CLEAR
 *   · `-=color` + nested flags markers work; `-=description`/`-=sort`/`-=sorting`/
 *     `-=folder` are accepted and SILENTLY IGNORED (never sent — docData is explicit)
 *   · `update({type})` genuinely re-types a live Folder (Macro behavior, not Actor)
 *   · nesting past 4 levels THROWS ("You may not nest Folders more than 4 levels deep")
 *   · plain `delete()` promotes children AND contents to ROOT — it never cascades
 *
 * What is genuinely folder-specific in the engine run:
 *
 *   1. The first claim-is-the-queue entity with a CREATE path — `everPushed: false`
 *      plan items take the create branch instead of reporting `world_deleted`.
 *   2. The first entity with platform-initiated DELETE — `deleted: true` plan items
 *      issue the plain folder-only delete, and an already-absent folder acks OK
 *      (the goal state is "gone"), never `world_deleted`.
 *
 * Transport is stubbed, Foundry is real: the REAL FolderPullSync runs a fixed plan.
 */

import { test, expect } from '@playwright/test'
import { ensureInGame } from '../shared/foundry-login.mjs'

const MODULE_URL = '/modules/crit-fumble-core/scripts/services/folder-pull-sync.js'

const FOLDER_ID = 'CfgFolderLiveTs1'
const PARENT_ID = 'CfgFolderLiveTs2'

/** A plan item shaped exactly like getFolderSyncPlanForWorld's output. */
function planItem(over = {}) {
  const { docData: docOver, ...rest } = over
  return {
    foundryFolderId: FOLDER_ID,
    everPushed: true,
    claimedAt: '2026-07-29T12:00:00.000Z',
    removedPaths: [],
    docData: {
      _id: FOLDER_ID,
      name: 'Live Folder',
      type: 'Actor',
      folder: null,
      sort: 100,
      color: '#ff0000',
      ...docOver,
    },
    ...rest,
  }
}

/** Drive ONE real tick of the real service against the live world. */
async function runTick(page, plan) {
  return page.evaluate(
    async ({ plan, moduleUrl, folderId }) => {
      const { FolderPullSync } = await import(moduleUrl)
      const acked = []
      const api = {
        getFolderSyncPlan: async () => ({ data: plan }),
        ackFolderSync: async (_inst, _world, results) => {
          acked.push(...results)
          return { data: { recorded: results.length } }
        },
      }
      await new FolderPullSync(api, 'inst-live-test').tick()

      const doc = game.folders.get(folderId)
      const src = doc?.toObject() ?? null
      return {
        acked,
        found: !!doc,
        name: src?.name ?? null,
        parent: src?.folder ?? null,
        sort: src?.sort ?? null,
        color: src?.color ?? null,
        createdAt: doc?._stats?.createdTime ?? null,
      }
    },
    { plan, moduleUrl: MODULE_URL, folderId: FOLDER_ID },
  )
}

async function cleanup(page) {
  await page.evaluate(async (prefix) => {
    for (const a of game.actors.filter((a) => a.id?.startsWith(prefix))) await a.delete()
    for (const f of game.folders.filter((f) => f.id?.startsWith(prefix))) await f.delete()
  }, 'CfgFolderLive')
}

test.describe('Folder write-back against real Foundry', () => {
  test.beforeEach(async ({ page }) => {
    await ensureInGame(page)
    await page.waitForFunction(() => window.CFGCore && game?.ready, { timeout: 30_000 })
    await cleanup(page)
  })

  test.afterEach(async ({ page }) => {
    await cleanup(page)
  })

  test('creates a platform-born folder with its id kept (everPushed: false)', async ({ page }) => {
    const res = await runTick(page, [planItem({ everPushed: false })])

    expect(res.found).toBe(true)
    expect(res.name).toBe('Live Folder')
    expect(res.sort).toBe(100)
    expect(res.color).toBe('#ff0000')
    expect(res.acked[0]).toMatchObject({ foundryFolderId: FOLDER_ID, ok: true, claimedAt: '2026-07-29T12:00:00.000Z' })
  })

  test('rename + move under a parent + clear color, updated in place', async ({ page }) => {
    const createdBefore = await page.evaluate(
      async ({ id, parentId }) => {
        await Folder.create({ _id: parentId, name: 'Live Parent', type: 'Actor' }, { keepId: true })
        await Folder.create({ _id: id, name: 'Live Folder', type: 'Actor', color: '#ff0000' }, { keepId: true })
        return game.folders.get(id)._stats.createdTime
      },
      { id: FOLDER_ID, parentId: PARENT_ID },
    )

    const res = await runTick(page, [planItem({ docData: { name: 'Renamed', folder: PARENT_ID, color: null } })])

    expect(res.name).toBe('Renamed')
    expect(res.parent).toBe(PARENT_ID)
    // `color: null` genuinely clears (measured) — no removal marker needed.
    expect(res.color).toBeNull()
    // Same id AND same creation stamp ⇒ updated in place, not deleted and rebuilt.
    expect(res.createdAt).toBe(createdBefore)
    expect(res.acked[0].ok).toBe(true)
  })

  test('deleted: true issues the folder-only delete — contents promote to root', async ({ page }) => {
    await page.evaluate(
      async ({ id, parentId }) => {
        await Folder.create({ _id: id, name: 'Doomed', type: 'Actor' }, { keepId: true })
        await Folder.create({ _id: parentId, name: 'Live Child', type: 'Actor', folder: id }, { keepId: true })
        await Actor.create({ _id: 'CfgFolderLiveA01', name: 'Live NPC', type: 'npc', folder: id }, { keepId: true })
      },
      { id: FOLDER_ID, parentId: PARENT_ID },
    )

    const res = await runTick(page, [planItem({ deleted: true, docData: undefined })])

    expect(res.found).toBe(false)
    // The delete never cascades: child folder and actor survive, promoted to root.
    // NB: existence and parent are read SEPARATELY — a promoted survivor's `folder`
    // is legitimately null, so `?.folder ?? 'GONE'` would lie about a live document.
    const survivors = await page.evaluate(
      ({ parentId }) => ({
        childExists: !!game.folders.get(parentId),
        childParent: game.folders.get(parentId)?.toObject()?.folder,
        actorExists: !!game.actors.get('CfgFolderLiveA01'),
        actorFolder: game.actors.get('CfgFolderLiveA01')?.toObject()?.folder,
      }),
      { parentId: PARENT_ID },
    )
    expect(survivors.childExists).toBe(true)
    expect(survivors.childParent).toBeNull()
    expect(survivors.actorExists).toBe(true)
    expect(survivors.actorFolder).toBeNull()
    expect(res.acked[0]).toMatchObject({ foundryFolderId: FOLDER_ID, ok: true, deleted: true })
  })

  test('deleting an already-absent folder acks OK — gone IS the goal state', async ({ page }) => {
    const res = await runTick(page, [planItem({ deleted: true, docData: undefined })])
    expect(res.acked[0]).toMatchObject({ ok: true, deleted: true })
  })

  test('reports world_deleted rather than re-creating a folder the GM deleted', async ({ page }) => {
    // Nothing seeded — the folder is absent and everPushed is true.
    const res = await runTick(page, [planItem()])
    expect(res.found).toBe(false)
    expect(res.acked[0]).toMatchObject({ ok: false, code: 'world_deleted' })
  })

  test('an empty plan does nothing and does not ack', async ({ page }) => {
    const res = await runTick(page, [])
    expect(res.acked).toEqual([])
  })
})
