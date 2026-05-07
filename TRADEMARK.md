# Trademark Policy

The following names, logos, and branding are trademarks of **Crit-Fumble Gaming LLC**
and are **not** licensed under the AGPL 3.0 license that governs this software:

- **Crit-Fumble** and **Crit-Fumble Gaming**
- **CFG** (as used in the context of the Crit-Fumble Gaming platform)
- The Crit-Fumble logo and visual identity

## What this means for forks

You are free to fork and deploy this software under the terms of the AGPL 3.0 license,
but you **must**:

1. Remove all references to "Crit-Fumble", "CFG", and related branding from your deployment.
2. Make clear your project is not affiliated with Crit-Fumble Gaming LLC.
3. Use your own name and identity.

## Rebranding guide

**Primary touchpoint** — most fork branding lives in one file:

| File                                        | What to change                                                                                                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/constants/branding.ts` | `platformName`, `platformShortName`, `productName`, `domain`, `legalEntity`, `communityName`, `apiTitle`, `digitalOceanRefCode`. Everything else reads from these constants. |

**Secondary touchpoints** — specific surfaces not yet fully driven by the branding constants:

| File / Location                                                     | What to change                                                                                                                                          |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/models/config/view.ts`                         | Public app description, support URLs                                                                                                                    |
| `apps/core-browser/src/views/components/organisms/nav/NavShell.tsx` | Logo and nav branding                                                                                                                                   |
| `docker/Caddyfile` + `docker/staging/Caddyfile`                     | Domain names (Caddy `email` is env-driven via `CADDY_ADMIN_EMAIL`)                                                                                      |
| `.env.production.example`                                           | `BASE_URL`, `AUTH_URL`, `CADDY_ADMIN_EMAIL`, image registry paths                                                                                       |
| `package.json`                                                      | `name` field                                                                                                                                            |
| Dev seed data (maintained outside this repo)                        | Seed data referencing CFG universes or content (the `cfg-` prefix on universe slugs is admin-only per platform convention; forks pick their own prefix) |

The `cfg-` prefix on Docker container names, volumes, and networks is a Docker-internal
convention and does not constitute trademark use — you may keep or change it.

## Questions

For licensing or trademark inquiries: crit.fumble.web@gmail.com
