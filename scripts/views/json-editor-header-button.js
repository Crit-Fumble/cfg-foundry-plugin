/**
 * Adds an "Edit JSON" control to Item / Actor / JournalEntry sheet headers, opening the CFG JSON
 * editor for that document (dt#212 parity).
 *
 * ── Why a DOM-injected button, not a header CONTROL ─────────────────────────────────────────────
 * Verified against live Foundry v13/dnd5e: the `getHeaderControls*` API renders controls that
 * dispatch a named `action` to the owning application, and there is no `onClick`. A control pushed
 * from a hook would carry an action the foreign sheet class has no handler for, so clicking it does
 * nothing. Injecting our own button with our own listener sidesteps that entirely.
 *
 * ── Why `renderDocumentSheetV2` ─────────────────────────────────────────────────────────────────
 * Also verified live: Foundry fires render hooks up the whole class chain, so a system's
 * `ItemSheet5e` never triggers a `renderItemSheet` hook — but it DOES trigger the generic
 * `renderDocumentSheetV2`, which fires for every document sheet regardless of system. Hooking that
 * one keeps this working for dnd5e, Cypher, and anything else, and covers compendium-opened
 * documents (they render the same sheet). The hook re-fires on every re-render, so the button is
 * re-injected after Foundry rebuilds the header; a dedup guard stops duplicates.
 */

'use strict'

import { openJsonEditor } from './cfg-json-editor.js'

const EDITABLE_DOCUMENTS = new Set(['Item', 'Actor', 'JournalEntry'])
const BUTTON_CLASS = 'cfg-json-edit-btn'

/** Register the header button. Call once, from the ready hook. */
export function registerJsonEditorHeaderButton() {
  Hooks.on('renderDocumentSheetV2', (app, element) => {
    try {
      injectButton(app, element)
    } catch (err) {
      // A header we could not decorate must never break the sheet render.
      console.debug?.('CFG Core | JSON editor button skipped:', err?.message || err)
    }
  })
}

function injectButton(app, element) {
  // GM-only: editing raw document JSON is a GM tool, and the write path assumes GM permissions.
  if (!game.user?.isGM) return

  const doc = app?.document
  if (!doc || !EDITABLE_DOCUMENTS.has(doc.documentName)) return

  const root = element instanceof HTMLElement ? element : app.element
  const header = root?.querySelector('.window-header')
  if (!header || header.querySelector(`.${BUTTON_CLASS}`)) return

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = `header-control icon fa-solid fa-code ${BUTTON_CLASS}`
  btn.dataset.tooltip = 'Edit JSON (CFG)'
  btn.setAttribute('aria-label', 'Edit JSON')
  btn.addEventListener('click', (event) => {
    event.preventDefault()
    openJsonEditor(doc)
  })

  // Sit just left of Close, matching where Foundry's own header controls live.
  const close = header.querySelector('[data-action="close"], [aria-label="Close Window"]')
  if (close) header.insertBefore(btn, close)
  else header.appendChild(btn)
}
