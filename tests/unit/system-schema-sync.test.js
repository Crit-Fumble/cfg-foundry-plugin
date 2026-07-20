/**
 * Game-system document schema sync (dt#212)
 *
 * Covers:
 *   - describeModel reads `schema.fields`, and falls back to a callable defineSchema()
 *   - required means "required with no default" — not merely `required: true`
 *   - readSystemSchemas skips document classes the system declares no dataModels for
 *   - a model that throws on introspection is skipped, never fatal
 *   - syncSystemSchemas POSTs to /api/v1/foundry/system-schema and names the installation
 *   - non-GM users skip entirely; push failures are typed results, never thrown
 */

import { jest } from '@jest/globals'

/**
 * Stubs `globalThis.fetch` and lets the real `fetchCfg` run, matching modules-sync.test.js. The
 * repo has no module-mocking precedent, and going through the real auth path is what proves the
 * Authorization header and the base URL are actually applied.
 */
function settingsStore(initial = {}) {
  const map = new Map(Object.entries(initial))
  game.settings.get = jest.fn((_mod, key) => map.get(key))
  game.settings.set = jest.fn(async (_mod, key, value) => {
    map.set(key, value)
  })
  return map
}

async function loadSync() {
  jest.resetModules()
  return await import('../../scripts/sync/system-schema-sync.js')
}

/** A DataField as Foundry shapes one. */
const field = (props = {}) => ({ required: false, nullable: false, initial: undefined, ...props })

/** A model whose schema is a SchemaField wrapping a field map. */
const model = (fields) => ({ schema: { fields } })

beforeEach(() => {
  jest.clearAllMocks()
  game.user = { isGM: true, id: 'test-gm-id' }
  game.system = { id: 'dnd5e', version: '5.3.3' }
  globalThis.CONFIG = {}
})

describe('describeModel', () => {
  it('reads the field map off schema.fields', async () => {
    const { describeModel } = await loadSync()
    expect(describeModel(model({ a: field(), b: field() }))).toEqual({ fields: ['a', 'b'] })
  })

  it('falls back to a callable defineSchema()', async () => {
    const { describeModel } = await loadSync()
    expect(describeModel({ defineSchema: () => ({ x: field() }) })).toEqual({ fields: ['x'] })
  })

  it('treats required-with-an-initial as NOT required of the GM', async () => {
    // Most Foundry fields are required AND carry an initial — the model fills them in, so erroring
    // on them would put a red underline under every well-formed document.
    const { describeModel } = await loadSync()
    const out = describeModel(model({ hp: field({ required: true, initial: 10 }) }))
    expect(out).toEqual({ fields: ['hp'] })
  })

  it('reports required-with-no-default, the case that actually breaks a document', async () => {
    const { describeModel } = await loadSync()
    const out = describeModel(
      model({
        classIdentifier: field({ required: true }),
        description: field({ required: true, initial: '' }),
      }),
    )
    // `description` has an empty-string default, so it lands in requiredNonEmpty — a different
    // finding from "absent", and reported separately.
    expect(out).toEqual({
      fields: ['classIdentifier', 'description'],
      required: ['classIdentifier'],
      requiredNonEmpty: ['description'],
    })
  })

  it('reads the default from getInitialValue(), not the `initial` property', async () => {
    // The live-prod regression. Every dnd5e 5.3.3 subclass field looks like this: required, not
    // nullable, `initial` undefined — yet each returns a real default from getInitialValue().
    // Testing `initial` marked all six required and errored on every well-formed subclass.
    const { describeModel } = await loadSync()
    const dnd5eShaped = (initial) => ({ required: true, nullable: false, initial: undefined, getInitialValue: () => initial })
    const out = describeModel(
      model({
        classIdentifier: dnd5eShaped(''),
        description: dnd5eShaped({ value: '', chat: '' }),
        source: dnd5eShaped({ revision: 1, rules: '2024' }),
      }),
    )
    expect(out.fields).toEqual(['classIdentifier', 'description', 'source'])
    expect(out.required).toBeUndefined()
    // classIdentifier's default is the empty string, so it is still reported — just as
    // "set this", not as "this is missing".
    expect(out.requiredNonEmpty).toEqual(['classIdentifier'])
  })

  it('flags a required field whose default is an EMPTY STRING', async () => {
    // The live case: dnd5e defaults classIdentifier to "", so a converted subclass attaches to no
    // class while looking perfectly well-formed.
    const { describeModel } = await loadSync()
    const dnd5eShaped = (initial) => ({ required: true, nullable: false, initial: undefined, getInitialValue: () => initial })
    const out = describeModel(
      model({
        classIdentifier: dnd5eShaped(''),
        identifier: dnd5eShaped(''),
        description: dnd5eShaped({ value: '', chat: '' }),
        advancement: dnd5eShaped({}),
      }),
    )
    expect(out.requiredNonEmpty).toEqual(['classIdentifier', 'identifier'])
    // An empty OBJECT default is a normal resting state — flagging it would bury the real finding.
    expect(out.requiredNonEmpty).not.toContain('description')
    expect(out.requiredNonEmpty).not.toContain('advancement')
  })

  it('omits requiredNonEmpty when nothing qualifies', async () => {
    const { describeModel } = await loadSync()
    const out = describeModel(model({ a: { required: true, nullable: false, getInitialValue: () => 'preset' } }))
    expect(out.requiredNonEmpty).toBeUndefined()
  })

  it('still reports a field whose getInitialValue() yields nothing', async () => {
    const { describeModel } = await loadSync()
    const out = describeModel(
      model({
        mustSupply: { required: true, nullable: false, initial: undefined, getInitialValue: () => undefined },
        hasDefault: { required: true, nullable: false, initial: undefined, getInitialValue: () => '' },
      }),
    )
    expect(out).toEqual({
      fields: ['mustSupply', 'hasDefault'],
      required: ['mustSupply'],
      requiredNonEmpty: ['hasDefault'],
    })
  })

  it('does not claim required when the initial-value machinery throws', async () => {
    const { describeModel } = await loadSync()
    const out = describeModel(model({ odd: { required: true, nullable: false, getInitialValue: () => { throw new Error('boom') } } }))
    expect(out).toEqual({ fields: ['odd'] })
  })

  it('does not call a nullable field required — null is its own default', async () => {
    const { describeModel } = await loadSync()
    expect(describeModel(model({ img: field({ required: true, nullable: true }) }))).toEqual({ fields: ['img'] })
  })

  it.each([
    ['null', null],
    ['a model with no schema', {}],
    ['a schema that throws', { get schema() { throw new Error('boom') } }],
  ])('returns null for %s rather than guessing', async (_label, input) => {
    const { describeModel } = await loadSync()
    expect(describeModel(input)).toBeNull()
  })
})

describe('readSystemSchemas', () => {
  it('projects each described document class', async () => {
    globalThis.CONFIG = {
      Item: { dataModels: { subclass: model({ classIdentifier: field({ required: true }) }) } },
      Actor: { dataModels: { npc: model({ cr: field() }) } },
    }
    const { readSystemSchemas } = await loadSync()
    const out = readSystemSchemas()

    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({
      systemId: 'dnd5e',
      systemVersion: '5.3.3',
      documentClass: 'Item',
      types: { subclass: { fields: ['classIdentifier'], required: ['classIdentifier'] } },
    })
    expect(out[1].documentClass).toBe('Actor')
  })

  it('skips a document class the system declares no dataModels for', async () => {
    globalThis.CONFIG = { Item: { dataModels: { feat: model({ a: field() }) } }, Actor: {} }
    const { readSystemSchemas } = await loadSync()
    expect(readSystemSchemas().map((d) => d.documentClass)).toEqual(['Item'])
  })

  it('skips a class whose every model failed to introspect', async () => {
    // An empty types map would read downstream as "this system declares no types", which is a
    // different and wrong claim.
    globalThis.CONFIG = { Item: { dataModels: { broken: null } } }
    const { readSystemSchemas } = await loadSync()
    expect(readSystemSchemas()).toEqual([])
  })

  it('returns nothing when there is no system to describe', async () => {
    globalThis.game.system = undefined
    globalThis.CONFIG = { Item: { dataModels: { feat: model({ a: field() }) } } }
    const { readSystemSchemas } = await loadSync()
    expect(readSystemSchemas()).toEqual([])
  })

  it('omits systemVersion when Foundry does not report one', async () => {
    globalThis.game.system = { id: 'cyphersystem' }
    globalThis.CONFIG = { Item: { dataModels: { skill: model({ a: field() }) } } }
    const { readSystemSchemas } = await loadSync()
    expect(readSystemSchemas()[0].systemVersion).toBeUndefined()
  })
})

describe('syncSystemSchemas', () => {
  let fetchSpy

  beforeEach(() => {
    settingsStore({ coreApiUrl: 'https://core.crit-fumble.com', apiKey: 'cfk_test' })
    globalThis.CONFIG = { Item: { dataModels: { feat: model({ a: field() }) } } }
    // Self-hosted shape: no hosted context and no /servers/foundryvtt/<id> path to read.
    globalThis.window.location = { pathname: '/game', origin: 'https://foundry.example' }
    fetchSpy = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ stored: 1 }),
      text: async () => '',
    }))
    globalThis.fetch = fetchSpy
  })

  it('POSTs the descriptors to /api/v1/foundry/system-schema', async () => {
    const { syncSystemSchemas } = await loadSync()
    const res = await syncSystemSchemas()

    expect(res).toEqual({ ok: true, count: 1 })
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://core.crit-fumble.com/api/v1/foundry/system-schema')
    expect(init.method).toBe('POST')
    expect(init.headers.get('Authorization')).toBe('Bearer cfk_test')
    expect(JSON.parse(init.body)).toEqual({
      schemas: [{ systemId: 'dnd5e', systemVersion: '5.3.3', documentClass: 'Item', types: { feat: { fields: ['a'] } } }],
    })
  })

  it('names the installation when the hosted path carries one', async () => {
    // On a cfg-hosted world the session cookie names a USER, not an installation — omitting this
    // is what 403'd module sync on every hosted world (dt#211).
    globalThis.window.location = { pathname: '/servers/foundryvtt/rotfs', origin: 'https://core.crit-fumble.com' }
    const { syncSystemSchemas } = await loadSync()
    await syncSystemSchemas()
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).installationId).toBe('rotfs')
  })

  it('skips entirely for a non-GM', async () => {
    game.user = { isGM: false, id: 'player-id' }
    const { syncSystemSchemas } = await loadSync()
    expect(await syncSystemSchemas()).toEqual({ ok: false, reason: 'not-gm' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not push when there is nothing to describe', async () => {
    globalThis.CONFIG = {}
    const { syncSystemSchemas } = await loadSync()
    expect(await syncSystemSchemas()).toEqual({ ok: false, reason: 'no-data-models' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns a push failure as a typed result rather than throwing', async () => {
    // Degrading to "no descriptor" is the pre-dt#212 experience; a thrown error during ready is not.
    globalThis.fetch = jest.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: 'offline' }),
      text: async () => '{"error":"offline"}',
    }))
    const { syncSystemSchemas } = await loadSync()
    const res = await syncSystemSchemas()
    expect(res.ok).toBe(false)
    expect(res.status).toBe(503)
  })
})
