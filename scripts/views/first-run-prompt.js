/**
 * First-run pair prompt (#571 / epic #419).
 *
 * When the plugin loads in a self-hosted (or third-party-hosted) Foundry
 * world that has never been linked to Crit-Fumble, the GM is offered a
 * one-tap "Link this world to CFG" dialog instead of having to dig through
 * Configure Settings. Mirrors the TaleSpire symbiote first-run pattern.
 *
 * The prompt is intentionally narrow: it fires only when ALL of these hold:
 *   1. The current Foundry user is the GM. Players can't pair — the API key
 *      is world-scoped and minted under the GM's account.
 *   2. The world is NOT cfg-hosted. CFG-hosted Foundry containers receive
 *      `window.__CFG_HOSTED_CONTEXT__` (#699) and auto-link without prompting.
 *   3. The world has no stored CFG `apiKey` yet. A linked world stays linked.
 *   4. The GM hasn't dismissed the prompt with "Don't Show Again" before.
 *
 * The dismissed flag is world-scoped on purpose: a GM running multiple worlds
 * may want CFG in some and not others. "Link Now" clears the flag on success
 * so a future Unlink + reload re-surfaces the prompt.
 */

'use strict'

import { startPairFlow, isLinked } from '../auth/pair-flow.js'
import { getHostKind } from '../auth/host-context.js'

const MODULE_ID = 'crit-fumble-core'
const DISMISSED_KEY = 'firstRunPromptDismissed'

/**
 * Read the dismissed flag, treating any setting-subsystem error as
 * "not dismissed" — the prompt shouldn't be silently suppressed because
 * Foundry's settings store hiccupped on load.
 */
function _isDismissed() {
  try {
    return game.settings.get(MODULE_ID, DISMISSED_KEY) === true
  } catch {
    return false
  }
}

async function _setDismissed(value) {
  try {
    await game.settings.set(MODULE_ID, DISMISSED_KEY, Boolean(value))
  } catch (err) {
    console.warn('CFG Core | first-run-prompt: failed to write dismissed flag:', err?.message || err)
  }
}

/**
 * Pure predicate — the four gating conditions, no side effects. Exported so
 * callers (and tests) can branch without touching the dialog at all.
 *
 * @returns {boolean}
 */
export function shouldShowFirstRunPrompt() {
  try {
    if (!game?.user?.isGM) return false
  } catch {
    return false
  }
  if (getHostKind() === 'cfg-hosted') return false
  if (isLinked()) return false
  if (_isDismissed()) return false
  return true
}

/**
 * Render the prompt unconditionally. `maybeShowFirstRunPrompt()` is the
 * gated entry point used by `Hooks.once('ready')`; this lower-level export
 * is kept separate so settings UIs (or tests) can re-trigger it after an
 * Unlink without duplicating the gating logic.
 *
 * @returns {Dialog}
 */
export function showFirstRunPrompt() {
  const dialog = new Dialog({
    title: 'Link this world to Crit-Fumble?',
    content: `
      <div style="padding: 0.5rem 0; font-size: 0.95rem;">
        <p>Crit-Fumble can manage character sheets, sessions, and campaigns
        for this world. Link now to get started.</p>
        <p style="opacity: 0.75; font-size: 0.85rem; margin-top: 0.5rem;">
        Linking opens a one-time confirmation page in your browser. You can
        also link later from Configure Settings &rarr; Crit-Fumble Link.</p>
      </div>
    `,
    buttons: {
      link: {
        icon: '<i class="fas fa-link"></i>',
        label: 'Link Now',
        callback: async () => {
          // Clear the dismissed flag so a future Unlink + reload re-prompts.
          await _setDismissed(false)
          try {
            await startPairFlow()
          } catch (err) {
            ui.notifications?.error?.(`CFG link failed: ${err?.message || err}`)
          }
        },
      },
      later: {
        icon: '<i class="fas fa-clock"></i>',
        label: 'Maybe Later',
        // No-op: the next world load re-fires the prompt.
      },
      never: {
        icon: '<i class="fas fa-times"></i>',
        label: "Don't Show Again",
        callback: async () => {
          await _setDismissed(true)
        },
      },
    },
    default: 'link',
  })
  dialog.render(true)
  return dialog
}

/**
 * Public entry point — call from `Hooks.once('ready')`. Runs the gating
 * checks and renders the prompt only when every condition is met. Returns
 * the rendered Dialog for tests; returns null when the prompt was skipped.
 *
 * The caller is responsible for any deferral (e.g. setTimeout) so the world's
 * own UI lands first; this function does not introduce its own delay.
 *
 * @returns {Dialog|null}
 */
export function maybeShowFirstRunPrompt() {
  if (!shouldShowFirstRunPrompt()) return null
  return showFirstRunPrompt()
}
