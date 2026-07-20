/**
 * In-Foundry JSON editor against a REAL FoundryVTT v14 + dnd5e world (dt#212 parity).
 *
 * The editor is DOM + Foundry document I/O end to end, so the meaningful coverage is real: does the
 * whole loop — serialize a live document, edit its JSON, run the shared diagnostics, apply through
 * the same write-back core, refuse a doomed save — actually behave against dnd5e. All of this was
 * confirmed by hand in the local harness; this pins it so it stays confirmed.
 *
 *   1. A VALID class→subclass conversion (drop HitPoints, set classIdentifier) saves, changes type,
 *      removes the advancement, and the resulting document's sheet RENDERS.
 *   2. A DOOMED conversion (keep HitPoints on the subclass) is refused by the health probe, nothing
 *      is written, and the document stays a class.
 */

import { test, expect } from '@playwright/test'
import { ensureInGame } from '../shared/foundry-login.mjs'

const EDITOR_URL = '/modules/crit-fumble-core/scripts/views/cfg-json-editor.js'

/** Build a class in a fresh world pack, drive the editor over it, return the outcome. Runs entirely
 *  in the world; the pack is cleaned up before returning. */
async function driveEditor(page, mutate) {
  return page.evaluate(
    async ({ editorUrl, mutateSrc }) => {
      const { CfgJsonEditor } = await import(editorUrl)
      const rid = () => foundry.utils.randomID()
      const packName = 'jsonedit-' + rid().slice(0, 6)
      const pack = await CompendiumCollection.createCompendium({ type: 'Item', label: packName, name: packName })
      const cls = await Item.create(
        {
          name: 'Spec Class',
          type: 'class',
          system: {
            identifier: 'spec',
            hd: { denomination: 'd8' },
            advancement: [
              { _id: rid(), type: 'HitPoints' },
              { _id: rid(), type: 'ItemGrant', level: 1 },
            ],
          },
        },
        { pack: pack.collection },
      )

      const editor = new CfgJsonEditor(await pack.getDocument(cls.id))
      await editor.render(true)
      await new Promise((r) => setTimeout(r, 500))
      // The editor is Foundry's native <code-mirror>; `.value` is the buffer.
      const cm = editor.element.querySelector('code-mirror')

      // eslint-disable-next-line no-new-func
      const mutate = new Function('obj', 'foundry', mutateSrc)
      const next = mutate(JSON.parse(cm.value), foundry)
      cm.value = JSON.stringify(next, null, 2)
      cm.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 250))

      // Read from the status element only — NOT all divs, which would include the CodeMirror
      // line-number gutter cells.
      const readStatus = () =>
        [...editor.element.querySelectorAll('.cfg-json-status > div')].map((d) => d.textContent.trim()).filter(Boolean)

      const diagnostics = readStatus()
      await editor._onSave()
      await new Promise((r) => setTimeout(r, 500))

      await pack.getIndex()
      const after = await pack.getDocument(cls.id)
      const sys = after ? after.toObject().system : null
      let sheetRenders = false
      if (after) {
        try {
          await after.sheet.render(true)
          await new Promise((r) => setTimeout(r, 500))
          sheetRenders = !!after.sheet.element
          after.sheet.close()
        } catch {
          sheetRenders = false
        }
      }

      const out = {
        diagnostics,
        postSave: readStatus(),
        typeAfter: after?.type ?? null,
        classIdentifierAfter: sys?.classIdentifier ?? null,
        advTypesAfter: sys ? Object.values(sys.advancement || {}).map((a) => a.type) : [],
        hasHdAfter: sys ? 'hd' in sys : null,
        sheetRenders,
      }
      editor.close()
      await pack.deleteCompendium()
      return out
    },
    { editorUrl: EDITOR_URL, mutateSrc: `return (${mutate.toString()})(obj, foundry)` },
  )
}

test.describe('In-Foundry JSON editor against real dnd5e', () => {
  test.beforeEach(async ({ page }) => {
    await ensureInGame(page)
    await page.waitForFunction(() => game?.ready && game.system?.id === 'dnd5e', { timeout: 30_000 })
  })

  test('a valid class→subclass conversion saves and the sheet renders', async ({ page }) => {
    const r = await driveEditor(page, (obj) => {
      obj.type = 'subclass'
      const adv = Array.isArray(obj.system.advancement) ? obj.system.advancement : Object.values(obj.system.advancement)
      obj.system = { classIdentifier: 'commander', identifier: 'spec', advancement: adv.filter((a) => a.type !== 'HitPoints') }
      return obj
    })

    expect(r.diagnostics).toEqual(['Valid.'])
    expect(r.typeAfter).toBe('subclass')
    expect(r.classIdentifierAfter).toBe('commander')
    expect(r.advTypesAfter).toEqual(['ItemGrant']) // HitPoints removal propagated
    expect(r.hasHdAfter).toBe(false)
    expect(r.sheetRenders).toBe(true)
  })

  test('a doomed conversion is refused, and the document stays a class', async ({ page }) => {
    const r = await driveEditor(page, (obj) => {
      obj.type = 'subclass' // keeps the HitPoints advancement — the doomed shape
      obj.system = { classIdentifier: '', advancement: obj.system.advancement }
      return obj
    })

    // The empty required fields are advised while typing…
    expect(r.diagnostics.join(' ')).toMatch(/empty on this "subclass"/)
    // …and the save is refused by the health probe, untouched.
    expect(r.postSave.join(' ')).toMatch(/fails to prepare/)
    expect(r.typeAfter).toBe('class')
  })
})
