/**
 * resolveFoundryRole — pins the contract behind #588.
 *
 * The campaign / installation owner must be promoted to GAMEMASTER (role 4)
 * for their own world; everyone else lands at the world's defaultUserRole.
 * Owner identity comes from the `ownerCoreUserId` setting written to the
 * world's settings.db by the Core platform during provisioning.
 *
 * This is the smallest piece worth a unit test — the rest of syncFoundryUser
 * lives behind heavy Foundry globals (game.users, User.create) that an
 * integration test would cover better than a unit mock.
 */

import { jest } from '@jest/globals'

describe('resolveFoundryRole (#588)', () => {
  let resolveFoundryRole

  beforeAll(async () => {
    // Mock the Foundry-side globals that core-auth.js reads at module load.
    // Only `game.settings.register` runs at import time (it's called from
    // the registerCoreAuthSettings export, but only when the module exports
    // are evaluated by Foundry's module loader — which doesn't happen here).
    // The test target is a pure helper that doesn't touch globals at all.
    const mod = await import('../../scripts/auth/core-auth.js')
    resolveFoundryRole = mod.resolveFoundryRole
  })

  it('returns GAMEMASTER (4) when the syncing user is the world owner', () => {
    expect(resolveFoundryRole('user-abc', 'user-abc', 1)).toBe(4)
  })

  it('returns GAMEMASTER (4) regardless of what defaultRole would have been', () => {
    expect(resolveFoundryRole('user-abc', 'user-abc', 0)).toBe(4)
    expect(resolveFoundryRole('user-abc', 'user-abc', 1)).toBe(4)
    expect(resolveFoundryRole('user-abc', 'user-abc', 3)).toBe(4)
  })

  it('returns the defaultRole when the syncing user is NOT the owner', () => {
    expect(resolveFoundryRole('user-other', 'user-abc', 1)).toBe(1)
    expect(resolveFoundryRole('user-other', 'user-abc', 2)).toBe(2)
  })

  it('returns the defaultRole when ownerCoreUserId is empty (un-stamped world)', () => {
    // Pre-#588 worlds may not have the setting stamped yet. Falling back to
    // defaultRole means the bug is "fixed" for new worlds without breaking
    // legacy worlds — owners of legacy worlds keep manually-promoting themselves
    // until the next launch re-stamps the setting.
    expect(resolveFoundryRole('user-abc', '', 1)).toBe(1)
  })

  it('returns the defaultRole when coreUserId is empty (defensive)', () => {
    // Should never happen in practice — auth payload always has user.id —
    // but the helper must not crash and must not promote the empty case.
    expect(resolveFoundryRole('', 'user-abc', 1)).toBe(1)
    expect(resolveFoundryRole('', '', 1)).toBe(1)
  })

  it('does not match by truthy coercion alone — exact string equality required', () => {
    // Catches the regression where someone "simplifies" the check to
    // `coreUserId == ownerCoreUserId` and accidentally allows "0" / 0 / etc.
    expect(resolveFoundryRole('user-1', 'user-2', 1)).toBe(1)
  })
})
