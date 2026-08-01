/**
 * Token HUD permission gate in the 3D overlay — SECURITY regression cover.
 *
 * Reported live 2026-07-31, mid-session: "one player could see the full GM menu on a
 * Hostile Enemy." Cause: on the 2D canvas Foundry never opens the Token HUD for a token
 * the user does not own — `Token#_canHUD` (`game.user.isGM || token.isOwner`) is consulted
 * by the interaction manager before the right-click reaches `canvas.hud.token`. The 3D
 * overlay does its own picking (`_pick` / `_pickNearest` filter on 3D VISIBILITY only), so
 * nothing upstream applied that gate and `_openTokenHudFor` bound the HUD to whatever token
 * was under the cursor.
 *
 * These tests drive the real `Overlay3D.prototype` methods against a fake `canvas.hud.token`
 * and assert on whether `bind` was called — i.e. whether the HUD would open — rather than
 * re-implementing the rule. The instance is `Object.create`d because the constructor builds
 * a whole three.js overlay that has nothing to do with the gate.
 */

import { jest } from '@jest/globals'

/** Fake Foundry surface. `bindCalls` records every token the HUD was bound to. */
function stubFoundry({ isGM = false } = {}) {
  const bindCalls = []
  globalThis.game = { user: { isGM, id: 'user-1' } }
  globalThis.canvas = {
    hud: {
      token: {
        bind: (tok) => bindCalls.push(tok),
        render: async () => {},
        element: null,
        clear: () => {},
      },
    },
    dimensions: { size: 100 },
  }
  globalThis.document = { body: { classList: { add: () => {}, remove: () => {} } } }
  globalThis.window = { innerWidth: 1400, innerHeight: 900 }
  return bindCalls
}

/** A token as the 3D picker hands it over: `document.isOwner` is the ownership signal. */
function makeToken({ isOwner = false, canHUD = undefined, id = 'tok-1' } = {}) {
  const tok = { id, document: { isOwner } }
  if (canHUD !== undefined) tok._canHUD = () => canHUD
  return tok
}

let Overlay3D
beforeAll(async () => {
  // Set the browser-ish globals the module may touch at import time BEFORE importing.
  stubFoundry()
  globalThis.CONFIG = { Canvas: {} }
  ;({ Overlay3D } = await import('../../scripts/services/overlay-3d.js'))
})

/** A bare instance — the constructor builds a three.js overlay irrelevant to this gate. */
function overlay() {
  return Object.create(Overlay3D.prototype)
}

describe('3D token HUD — ownership gate', () => {
  test('a NON-owner player gets NO HUD on a hostile NPC (the reported bug)', async () => {
    const bindCalls = stubFoundry({ isGM: false })
    await overlay()._openTokenHudFor(makeToken({ isOwner: false }), 100, 100)
    expect(bindCalls).toHaveLength(0)
  })

  test('a player DOES get the HUD on a token they own', async () => {
    const bindCalls = stubFoundry({ isGM: false })
    const tok = makeToken({ isOwner: true })
    await overlay()._openTokenHudFor(tok, 100, 100)
    expect(bindCalls).toEqual([tok])
  })

  test('a GM gets the HUD on any token', async () => {
    const bindCalls = stubFoundry({ isGM: true })
    const tok = makeToken({ isOwner: false })
    await overlay()._openTokenHudFor(tok, 100, 100)
    expect(bindCalls).toEqual([tok])
  })

  test("delegates to Foundry's own _canHUD when the build exposes it", async () => {
    const bindCalls = stubFoundry({ isGM: false })
    // Foundry says no even though our fallback rule (isOwner) would say yes — Foundry wins.
    await overlay()._openTokenHudFor(makeToken({ isOwner: true, canHUD: false }), 100, 100)
    expect(bindCalls).toHaveLength(0)

    // …and Foundry says yes even though the fallback would say no.
    const allowed = makeToken({ isOwner: false, canHUD: true, id: 'tok-2' })
    await overlay()._openTokenHudFor(allowed, 100, 100)
    expect(bindCalls).toEqual([allowed])
  })

  test('a null/absent pick never opens the HUD', async () => {
    const bindCalls = stubFoundry({ isGM: true })
    await overlay()._openTokenHudFor(null, 100, 100)
    expect(bindCalls).toHaveLength(0)
  })
})
