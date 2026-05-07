/**
 * Installed-module sync (#339)
 *
 * Reads `game.modules` once per Foundry world ready and POSTs the list to
 * CFG via `fetchCfg`. The platform persists it on the paired
 * UserAppInstallation so the platform UI can render "what's actually
 * installed in this Foundry world" — works the same for cfg-hosted,
 * self-hosted and third-party Foundry instances (no filesystem scan).
 *
 * GM-only. The plugin is single-instance per world; the GM's view of
 * `game.modules` is the same all players see, so we don't need a player
 * sync to duplicate what the GM already sent.
 *
 * Subsequent module install/uninstall during the same Foundry session
 * doesn't re-trigger the sync — that's fine for v1; the next world reload
 * will catch up.
 */

'use strict'

import { fetchCfg } from '../auth/pair-flow.js'

/**
 * Snapshot the world's modules and POST to CFG.
 * Returns a typed result so callers / tests can branch without try/catch.
 *
 * @returns {Promise<{ok: true, count: number} | {ok: false, reason: string, status?: number}>}
 */
export async function syncInstalledModules() {
  // GM-only. We could let players sync too — they see the same module list —
  // but every client running this would just produce duplicate writes.
  if (!game?.user?.isGM) {
    return { ok: false, reason: 'not-gm' }
  }

  const modules = readWorldModules()
  const res = await fetchCfg('/api/v1/foundry/modules', {
    method: 'POST',
    body: JSON.stringify({ modules }),
  })

  if (res.ok) {
    console.log(`CFG Core | Synced ${modules.length} installed modules`)
    return { ok: true, count: modules.length }
  }

  // Don't surface a notification banner here — the offline / connection
  // banner already covers reachability. Module sync failure is non-fatal.
  console.warn('CFG Core | Module sync skipped:', res.reason, res.status ?? '')
  return { ok: false, reason: res.reason, status: res.status }
}

/**
 * Read `game.modules` and project to the wire shape the server expects.
 * Foundry V13+ exposes `game.modules.contents`; V12 falls back to iterating
 * the Map via `entries()`. Either way the entry shape is the same: a
 * Module-document-ish object with `id`, `title`, `version`, `compatibility`.
 *
 * @returns {Array<{id: string, title: string, version: string, compatibility?: object}>}
 */
export function readWorldModules() {
  const out = []
  const mods = game?.modules
  if (!mods) return out

  // V13+: an Iterable with a `.contents` array.
  // V12: a Map with `.entries()`.
  let iterable
  if (Array.isArray(mods.contents)) {
    iterable = mods.contents
  } else if (typeof mods.entries === 'function') {
    iterable = Array.from(mods.entries(), ([, m]) => m)
  } else if (typeof mods[Symbol.iterator] === 'function') {
    iterable = Array.from(mods)
  } else {
    return out
  }

  for (const m of iterable) {
    if (!m || typeof m !== 'object' || !m.id) continue

    const compat = m.compatibility
    const projected = {
      id: String(m.id),
      title: String(m.title ?? m.id),
      version: String(m.version ?? '0.0.0'),
    }

    if (compat && typeof compat === 'object') {
      const c = {}
      if (compat.minimum != null) c.minimum = String(compat.minimum)
      if (compat.verified != null) c.verified = String(compat.verified)
      if (compat.maximum != null) c.maximum = String(compat.maximum)
      if (Object.keys(c).length > 0) projected.compatibility = c
    }

    out.push(projected)
  }

  // Stable order for reproducibility — server sorts by title on read, but
  // reading by id is what the wire shape promises and what tests assert on.
  out.sort((a, b) => a.id.localeCompare(b.id))
  return out
}
