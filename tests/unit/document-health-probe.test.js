/**
 * Document health probe (dt#213) — unit-level logic.
 *
 * This covers the probe's CONTROL FLOW against a fake DocClass: construct-then-walk-advancements,
 * catch a throw, degrade to ok when there is nothing to probe. The claim that Foundry actually
 * behaves this way — that `new DocClass()` swallows the prep error and the crash only surfaces on
 * the advancement's level-preview methods — is not something jest can assert; it is pinned by the
 * real-Foundry integration spec (specs/document-health-probe.spec.js), which is why that spec
 * exists rather than a pile of mocks pretending to be dnd5e.
 */

import { jest } from '@jest/globals'

async function loadProbe() {
  jest.resetModules()
  return await import('../../scripts/services/document-health-probe.js')
}

beforeEach(() => {
  // The probe deep-clones input via foundry.utils; provide the one helper it touches.
  globalThis.foundry = { utils: { deepClone: (v) => JSON.parse(JSON.stringify(v)) } }
})

/** A fake Foundry document class: constructs unless `throwOnConstruct`, exposes a prepared
 *  advancement index whose instances' level-preview methods throw when told to. */
function makeDocClass({ throwOnConstruct = null, advancements = [] } = {}) {
  return class FakeDoc {
    constructor(data) {
      if (throwOnConstruct) throw new Error(throwOnConstruct)
      this.type = data.type
      this.advancement = advancements.length
        ? { byId: Object.fromEntries(advancements.map((a, i) => [String(i), a])) }
        : undefined
    }
  }
}

/** An advancement instance whose named method throws. */
function advancement(name, { throwsOn = null, message = 'boom' } = {}) {
  const inst = { type: name, constructor: { name: `${name}Advancement` } }
  for (const m of ['sortingValueForLevel', 'titleForLevel', 'valueForLevel']) {
    inst[m] = () => {
      if (m === throwsOn) throw new Error(message)
    }
  }
  return inst
}

describe('probeDocumentHealth', () => {
  it('passes a document whose advancements all prepare cleanly', async () => {
    const { probeDocumentHealth } = await loadProbe()
    const DocClass = makeDocClass({ advancements: [advancement('ItemGrant'), advancement('Trait')] })
    expect(probeDocumentHealth(DocClass, { type: 'subclass' })).toEqual({ ok: true })
  })

  it('flags a document whose advancement throws on a level-preview method', async () => {
    // The HitPoints-on-a-subclass shape: the sheet calls sortingValueForLevel and it reads a
    // missing field.
    const { probeDocumentHealth } = await loadProbe()
    const DocClass = makeDocClass({
      advancements: [advancement('HitPoints', { throwsOn: 'sortingValueForLevel', message: "Cannot read 'denomination'" })],
    })
    const r = probeDocumentHealth(DocClass, { type: 'subclass' })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('HitPointsAdvancement')
    expect(r.reason).toContain('subclass')
    expect(r.reason).toContain("Cannot read 'denomination'")
  })

  it('reports a construction/validation failure distinctly', async () => {
    const { probeDocumentHealth } = await loadProbe()
    const DocClass = makeDocClass({ throwOnConstruct: 'must be a valid 16-character alphanumeric ID' })
    const r = probeDocumentHealth(DocClass, { type: 'subclass' })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/Document is invalid/)
  })

  it('passes a document with no advancement index — nothing to probe (Cypher, most item types)', async () => {
    const { probeDocumentHealth } = await loadProbe()
    const DocClass = makeDocClass({ advancements: [] })
    expect(probeDocumentHealth(DocClass, { type: 'feat' })).toEqual({ ok: true })
  })

  it('does not block when handed no DocClass or no data — it must never invent a failure', async () => {
    const { probeDocumentHealth } = await loadProbe()
    expect(probeDocumentHealth(null, { type: 'x' })).toEqual({ ok: true })
    expect(probeDocumentHealth(makeDocClass(), null)).toEqual({ ok: true })
  })
})
