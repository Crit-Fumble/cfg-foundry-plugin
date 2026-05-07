# Owner Promotion (Foundry GM role) — #588

## Why this exists

When a Crit-Fumble user creates a campaign and launches FoundryVTT, they
need to land in their world as a Foundry **GAMEMASTER** (role 4). Without
this, they can't upload assets, build scenes, or manage tokens — they have
to ask a platform admin to promote them, which is a terrible first
experience for a paid tier.

The Core Auth Bypass flow (`syncFoundryUser` in
`scripts/auth/core-auth.js`) used to assign every newly-created Foundry
user the world's `defaultUserRole` (typically Player = 1), regardless of
ownership. This document is the contract for the fix.

## How owner identity flows from server to plugin

```
┌────────────────────────────┐        ┌────────────────────────────┐
│ Core platform              │        │ Foundry world              │
│ apps/core-server/src/      │        │ Data/worlds/{id}/data/     │
│   services/foundry/        │        │   settings.db              │
│   foundry-management.ts    │        │                            │
│                            │        │                            │
│ syncCfgPlugin(             │  →     │ key:                       │
│   vttDataPath,             │        │   crit-fumble-core         │
│   ownerCoreUserId,         │        │   .ownerCoreUserId         │
│ )                          │        │ value: "<core-user-id>"    │
└────────────────────────────┘        └────────────────────────────┘
                                                    │
                                                    ▼
                                       ┌────────────────────────────┐
                                       │ crit-fumble-core plugin    │
                                       │ scripts/auth/core-auth.js  │
                                       │                            │
                                       │ syncFoundryUser(authData): │
                                       │   coreUserId =             │
                                       │     authData.user.id       │
                                       │   ownerId =                │
                                       │     game.settings.get(     │
                                       │       MODULE_ID,           │
                                       │       'ownerCoreUserId',   │
                                       │     )                      │
                                       │   role = (coreUserId       │
                                       │     === ownerId)           │
                                       │     ? GAMEMASTER (4)       │
                                       │     : defaultRole          │
                                       └────────────────────────────┘
```

## Server contract

The Core platform writes `crit-fumble-core.ownerCoreUserId` to each world's
`settings.db` at the same time it enables the plugin. This happens on every
launch via `syncCfgPlugin(vttDataPath, ownerCoreUserId)`.

- The owner ID is the `userId` of the `UserAppInstallation` row.
- The write is idempotent — settings.db is NeDB (last-write-wins by `key`),
  and the helper no-ops when the latest entry already matches.
- If `ownerCoreUserId` is omitted (e.g. admin instance), the stamp is
  skipped and ownership-based promotion never fires for that world.

## Plugin contract

`syncFoundryUser` reads `ownerCoreUserId` once per call. The pure
`resolveFoundryRole(coreUserId, ownerCoreUserId, defaultRole)` helper
returns the role to assign:

- `coreUserId === ownerCoreUserId` (and both non-empty) → role 4 (GM)
- otherwise → `defaultRole` from world settings

Two branches use the same logic:

1. **New-user create** — pass `desiredRole` to `User.create(...)`.
2. **Existing-user update** — if the user is the owner AND their current
   role is below GM, idempotently `update({ role: 4 })`. We **never demote**
   an existing user; a manually-promoted assistant or trusted player keeps
   their access if they happen to re-auth through Core.

## Edge cases

| Situation                                        | Behavior                                                                                                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pre-#588 world without `ownerCoreUserId` stamped | Plugin falls back to `defaultRole` for everyone. Owner can manually promote themselves until the next launch re-stamps the setting.                |
| Player auths first, owner auths later            | Player lands at `defaultRole`. Owner lands at GM. Each user is evaluated against the world's owner ID independently.                               |
| Owner already exists at GM                       | `update({ role: 4 })` no-ops; logs `Updated existing user`.                                                                                        |
| World linked to a realm via `linkWorldToRealm`   | The realm-world path is outside the standard `Data/worlds/` sweep. Tracked as a follow-up — see TODO at `foundry-realm-world.ts:linkWorldToRealm`. |
| Admin instance                                   | `syncCfgPlugin` is not called for the admin instance (it has its own setup path); admins are GM via Foundry's native `admin.txt` flow.             |

## Tests

- `tests/unit/resolve-foundry-role.test.js` — pins the pure helper across
  all six combinations of (owner=user, owner≠user, empty owner, empty
  user, etc.).
- The full `syncFoundryUser` flow lives behind heavy Foundry globals
  (`game.users`, `User.create`); integration coverage belongs in the
  `tests/integration/` Playwright suite.

## Don't re-introduce the bug

If you touch `syncFoundryUser`, keep the role decision delegated to
`resolveFoundryRole`. Don't read `defaultRole` directly into a `User.create`
call without going through the helper — that's literally how this bug
shipped originally.
