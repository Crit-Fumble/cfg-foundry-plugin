/**
 * Document health probe against a REAL FoundryVTT v14 + dnd5e world (dt#213).
 *
 * The unit tests assert the probe's CONTROL FLOW against a fake DocClass. They cannot assert the
 * thing the whole feature rests on: that Foundry actually behaves the way the probe assumes.
 * Everything risky here is a fact about the real dnd5e runtime, and only real dnd5e can confirm it:
 *
 *   1. `new Item(badData)` does NOT throw — `_safePrepareData` swallows the prep error. A probe
 *      that trusted construction to fail would pass every doomed document. (Verified live; this is
 *      why the probe walks the advancement instances instead.)
 *   2. A HitPoints advancement on a `subclass` really does throw on `sortingValueForLevel`, reading
 *      the `system.hd` a subclass discards — the exact production crash.
 *   3. A `class` carrying the SAME HitPoints advancement (with its `hd`) prepares cleanly, so the
 *      probe does not flag legitimate classes. This is the false-positive that would break every
 *      class in every world, so it is the most important assertion here.
 *   4. The write-back REFUSES the doomed conversion without deleting the live document — the
 *      delete-then-crash corruption the guard exists to prevent.
 *
 * Foundry is real; there is no Core stack and no transport — the probe is a pure function and the
 * write-back is driven with a fake pack/entry. A failure here means dnd5e disagrees with us, not
 * that fixtures are unseeded.
 */

import { test, expect } from '@playwright/test'
import { ensureInGame } from '../shared/foundry-login.mjs'

const PROBE_URL = '/modules/crit-fumble-core/scripts/services/document-health-probe.js'
const SYNC_URL = '/modules/crit-fumble-core/scripts/services/compendium-pull-sync.js'

test.describe('Document health probe against real dnd5e', () => {
  test.beforeEach(async ({ page }) => {
    await ensureInGame(page)
    await page.waitForFunction(() => game?.ready && game.system?.id === 'dnd5e', { timeout: 30_000 })
  })

  test('probe discriminates the real crash from healthy documents', async ({ page }) => {
    const result = await page.evaluate(async (probeUrl) => {
      const { probeDocumentHealth } = await import(probeUrl)
      const DocClass = CONFIG.Item.documentClass
      const rid = () => foundry.utils.randomID()
      const mk = (type, system) => ({ name: 'Probe', type, system })

      // Establish fact (1): the doomed doc does NOT throw on construction.
      let constructThrew = false
      try {
        new DocClass(mk('subclass', { classIdentifier: 'x', advancement: [{ _id: rid(), type: 'HitPoints' }] }))
      } catch {
        constructThrew = true
      }

      const probe = (type, system) => probeDocumentHealth(DocClass, mk(type, system))
      return {
        constructThrew,
        badSubclass: probe('subclass', { classIdentifier: 'x', advancement: [{ _id: rid(), type: 'HitPoints' }] }),
        goodSubclass: probe('subclass', { classIdentifier: 'x', advancement: [{ _id: rid(), type: 'ItemGrant', level: 1 }] }),
        // The false-positive guard: a class legitimately has hit dice AND a HitPoints advancement.
        classWithHitPoints: probe('class', {
          identifier: 'commander',
          hd: { denomination: 'd10', spent: 0 },
          advancement: [{ _id: rid(), type: 'HitPoints' }],
        }),
        emptySubclass: probe('subclass', { classIdentifier: 'x' }),
        feat: probe('feat', {}),
      }
    }, PROBE_URL)

    // (1) construction swallows the error — the reason the probe cannot rely on it.
    expect(result.constructThrew).toBe(false)

    // (2) the doomed conversion is caught, with a reason that names the culprit.
    expect(result.badSubclass.ok).toBe(false)
    expect(result.badSubclass.reason).toContain('HitPointsAdvancement')
    expect(result.badSubclass.reason).toContain('subclass')

    // (3) everything healthy passes — most importantly a real class with hit dice.
    expect(result.goodSubclass).toEqual({ ok: true })
    expect(result.classWithHitPoints).toEqual({ ok: true })
    expect(result.emptySubclass).toEqual({ ok: true })
    expect(result.feat).toEqual({ ok: true })
  })

  test('the write-back refuses a doomed conversion without deleting the live document', async ({ page }) => {
    const result = await page.evaluate(
      async ({ syncUrl }) => {
        const bust = '?v=' + foundry.utils.randomID()
        const { CompendiumPullSync } = await import(syncUrl + bust)
        const rid = () => foundry.utils.randomID()

        const packName = 'dt213-spec-' + rid().slice(0, 6)
        const pack = await CompendiumCollection.createCompendium({ type: 'Item', label: packName, name: packName })
        const cls = await Item.create(
          {
            name: 'Probe Class',
            type: 'class',
            system: { identifier: 'probe-class', hd: { denomination: 'd8' }, advancement: [{ _id: rid(), type: 'HitPoints' }] },
          },
          { pack: pack.collection },
        )

        // Desired state: convert to subclass, KEEPING the HitPoints advancement — the broken shape.
        const badDoc = {
          ...cls.toObject(),
          type: 'subclass',
          system: { classIdentifier: 'probe-class', advancement: cls.toObject().system.advancement },
        }

        const svc = new CompendiumPullSync({})
        let threwName = null
        try {
          await svc._applyEntry(pack, { foundryEntryId: cls.id, doc: badDoc })
        } catch (e) {
          threwName = e.name
        }

        await pack.getIndex()
        const after = await pack.getDocument(cls.id).catch(() => null)
        const out = { threwName, stillExists: !!after, typeAfter: after?.type ?? null }

        await pack.deleteCompendium()
        return out
      },
      { syncUrl: SYNC_URL },
    )

    expect(result.threwName).toBe('DocumentHealthError')
    // (4) the class survives, untouched — no delete-then-crash.
    expect(result.stillExists).toBe(true)
    expect(result.typeAfter).toBe('class')
  })
})
