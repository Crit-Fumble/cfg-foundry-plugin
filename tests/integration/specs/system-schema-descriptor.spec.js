/**
 * Schema descriptor extraction against a REAL FoundryVTT v14 + dnd5e world (dt#212).
 *
 * The unit tests assert `describeModel`'s control flow against hand-built fake fields. They cannot
 * assert the premise the whole feature rests on: that a real dnd5e DataModel, introspected live,
 * actually yields the shape the editor's warnings are computed from. Every bug this feature has
 * shipped was in that gap:
 *
 *   - `.initial` vs `getInitialValue()` — every dnd5e 5.3.3 field is `initial: undefined`, so
 *     reading `.initial` marked ALL SIX subclass fields required-with-no-default and the editor
 *     would have thrown a hard error on every well-formed subclass. A bad descriptor was live in
 *     prod before this was caught by hand. Nothing but a real model can catch it again.
 *   - The empty-default half (`requiredNonEmpty`) has NEVER been driven against a real system —
 *     the live pass in docs/notes/schema-aware-editor-2026-07-20.md predates it (plugin 2.20.0).
 *
 * Foundry is real; there is no Core stack and no transport — extraction and checking are both pure
 * functions of `CONFIG`. A failure here means dnd5e's model changed, not that fixtures are unseeded.
 */

import { test, expect } from '@playwright/test'
import { ensureInGame } from '../shared/foundry-login.mjs'

const SYNC_URL = '/modules/crit-fumble-core/scripts/sync/system-schema-sync.js'
const CORE_URL = '/modules/crit-fumble-core/scripts/lib/code-editor-core.js'

test.describe('System schema descriptor from real dnd5e', () => {
  test.beforeEach(async ({ page }) => {
    await ensureInGame(page)
    await page.waitForFunction(() => game?.ready && game.system?.id === 'dnd5e', { timeout: 30_000 })
  })

  test('describes class and subclass the way the warnings assume', async ({ page }) => {
    const d = await page.evaluate(async (url) => {
      const { descriptorForDocumentClass } = await import(url)
      return descriptorForDocumentClass('Item')
    }, SYNC_URL)

    expect(d).not.toBeNull()
    expect(d.systemId).toBe('dnd5e')
    expect(d.systemVersion).toBeTruthy()

    // The data-loss case: these live on a class and have no home on a subclass, so Foundry drops
    // them silently. This asymmetry IS the discard warning.
    for (const f of ['hd', 'levels', 'primaryAbility']) {
      expect(d.types.class.fields).toContain(f)
      expect(d.types.subclass.fields).not.toContain(f)
    }

    // The empty-default case: `classIdentifier` is present-but-"" on a converted subclass, which
    // "is the key missing?" can never see. It must land in requiredNonEmpty, not required.
    expect(d.types.subclass.requiredNonEmpty).toContain('classIdentifier')

    // The getInitialValue regression, pinned: dnd5e defaults every field, so nothing on a subclass
    // is genuinely defaultless. A non-empty `required` here means the extractor is reading
    // `.initial` again and the editor is about to hard-error on well-formed documents.
    expect(d.types.subclass.required ?? []).toEqual([])

    // Object-valued defaults are a normal resting state; flagging them would bury classIdentifier.
    expect(d.types.subclass.requiredNonEmpty).not.toContain('description')
  })

  test('a class converted to a subclass produces both findings', async ({ page }) => {
    const issues = await page.evaluate(
      async ([syncUrl, coreUrl]) => {
        const { descriptorForDocumentClass } = await import(syncUrl)
        const { checkAgainstSystemSchema } = await import(coreUrl)
        // What a GM is actually looking at mid-conversion: the class's own system block, with the
        // type flipped to subclass and classIdentifier still at its "" default.
        const doc = {
          type: 'subclass',
          system: {
            classIdentifier: '',
            identifier: 'commander',
            hd: { denomination: 'd10', spent: 0 },
            levels: 20,
            primaryAbility: { value: ['str'] },
          },
          flags: { 'crit-fumble-core': { scratch: true } },
        }
        return checkAgainstSystemSchema(doc, descriptorForDocumentClass('Item'), { ignoreKeys: ['flags'] })
      },
      [SYNC_URL, CORE_URL],
    )

    const warning = issues.find((i) => i.severity === 'warning')
    expect(warning, 'the discard warning must fire on a real conversion').toBeTruthy()
    for (const f of ['hd', 'levels', 'primaryAbility']) expect(warning.message).toContain(f)

    const error = issues.find((i) => i.severity === 'error')
    expect(error, 'an empty classIdentifier must be reported').toBeTruthy()
    expect(error.message).toContain('classIdentifier')

    // `flags` is preserved verbatim by Foundry and is what the warning tells people to use.
    expect(JSON.stringify(issues)).not.toContain('scratch')
  })
})
