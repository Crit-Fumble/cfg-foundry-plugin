/**
 * CFG JSON Editor — raw document JSON editing inside Foundry, at parity with PlayTable's editor
 * (dt#212 parity). Reached from a header button on Item / Actor / JournalEntry sheets, including
 * documents opened from a compendium.
 *
 * The editor widget is Foundry v13's OWN `<code-mirror>` custom element — the same one its "edit
 * HTML source" surface uses — so line numbers and JSON syntax highlighting come for free, with no
 * CodeMirror bundled into the plugin. On top of Foundry's defaults we layer OUR rules: the discard
 * warning, the required-but-empty error, JSON formatting, and the pre-save health probe — the same
 * validation PlayTable runs, from the same shared code-editor core (`scripts/lib/code-editor-core.js`).
 *
 * The save goes through the SAME `applyDesiredDocument` the compendium write-back uses, so a type
 * change, a field removal and a doomed document behave identically here and there.
 */

'use strict'

import {
  parseJson,
  formatJsonText,
  checkFoundryDoc,
  checkAgainstSystemSchema,
} from '../lib/code-editor-core.js'
import { applyDesiredDocument, DocumentHealthError } from '../services/document-apply.js'
import { descriptorForDocumentClass } from '../sync/system-schema-sync.js'

const { ApplicationV2 } = foundry.applications.api

export class CfgJsonEditor extends ApplicationV2 {
  /** @param {ClientDocument} document  the live Foundry document to edit */
  constructor(document, options = {}) {
    super(options)
    this._document = document
    // The system's schema for this document class, so the diagnostics match PlayTable's. Null for
    // a class the system does not describe (most non-dnd5e items) — the checks then simply no-op.
    this._descriptor = descriptorForDocumentClass(document.documentName)
    this._statusEl = null
    this._cm = null
  }

  static DEFAULT_OPTIONS = {
    id: 'cfg-json-editor',
    tag: 'div',
    window: { title: 'Edit JSON', icon: 'fa-solid fa-code', resizable: true },
    position: { width: 720, height: 640 },
    classes: ['themed', 'cfg-app', 'cfg-json-editor'],
  }

  get title() {
    return `Edit JSON — ${this._document?.name ?? this._document?.documentName ?? 'Document'}`
  }

  /* -------------------------------------------- */

  async _renderHTML() {
    const root = document.createElement('div')
    root.style.cssText = 'display:flex; flex-direction:column; gap:0.5rem; padding:0.75rem; height:100%;'

    const toolbar = document.createElement('div')
    toolbar.style.cssText = 'display:flex; gap:0.5rem; flex-wrap:wrap;'
    toolbar.appendChild(this._button('Save', () => this._onSave()))
    toolbar.appendChild(this._button('Format', () => this._onFormat()))
    toolbar.appendChild(this._button('Download', () => this._onDownload()))
    toolbar.appendChild(this._button('Upload', () => this._onUpload()))
    root.appendChild(toolbar)

    // Foundry v13 ships a CodeMirror editor as the `<code-mirror>` custom element — the same one
    // its own "edit HTML source" surface uses — so line numbers and JSON highlighting come for
    // FREE, with no CodeMirror bundled into the plugin. Verified in-world: `language="json"`
    // highlights, `.value` round-trips, and it fires `input`/`change` on edit. Our diagnostics and
    // the health probe layer on top; Foundry owns the widget.
    const cm = document.createElement('code-mirror')
    cm.setAttribute('language', 'json')
    cm.setAttribute('indent', '2')
    cm.setAttribute('name', 'cfg-json')
    cm.style.cssText =
      'flex:1; min-height:0; display:block; overflow:auto; ' +
      'border:1px solid var(--color-border-light-tertiary,#888); border-radius:4px;'
    // `.value` is applied on connect; the initial serialize is (re)set in _onRender to be safe
    // once the element is in the DOM and its CM view exists.
    cm.addEventListener('input', () => this._revalidate())
    this._cm = cm
    root.appendChild(cm)

    const status = document.createElement('div')
    // A stable hook so tests read diagnostics from HERE, not from the CodeMirror line-number gutter
    // (whose cells are also leaf divs with text).
    status.className = 'cfg-json-status'
    status.style.cssText = 'min-height:2.5rem; font-size:0.8rem; display:flex; flex-direction:column; gap:0.15rem;'
    this._statusEl = status
    root.appendChild(status)

    return root
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result)
  }

  async _onRender() {
    // Seed the editor now that the element is connected and its CM view is built.
    if (this._cm) this._cm.value = this._serialize()
    this._revalidate()
  }

  /* -------------------------------------------- */
  /*  Actions                                      */
  /* -------------------------------------------- */

  _serialize() {
    try {
      return JSON.stringify(this._document.toObject(), null, 2)
    } catch {
      return '{}'
    }
  }

  /**
   * Recompute diagnostics for the current buffer. Returns whether the buffer is SAVEABLE (parses
   * and carries no Foundry-invariant error). Schema findings advise but never block — the GM
   * mid-conversion decides — matching PlayTable.
   */
  _revalidate() {
    const text = this._cm?.value ?? ''
    const messages = []
    let saveable = false

    const parsed = parseJson(text)
    if (!parsed.ok) {
      messages.push({ severity: 'error', message: `Invalid JSON: ${parsed.error.message} (line ${parsed.error.line})` })
    } else {
      const blocking = checkFoundryDoc(parsed.value, {}).filter((i) => i.severity === 'error')
      // Advisories: Foundry-doc warnings + the system-schema findings (discard + required-empty).
      const advisories = [
        ...checkFoundryDoc(parsed.value, {}).filter((i) => i.severity === 'warning'),
        ...checkAgainstSystemSchema(parsed.value, this._descriptor, { ignoreKeys: ['flags'] }),
      ].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))

      saveable = blocking.length === 0
      messages.push(...blocking, ...advisories)
    }

    this._renderStatus(messages, saveable)
    return saveable
  }

  _renderStatus(messages, saveable) {
    const el = this._statusEl
    if (!el) return
    el.replaceChildren()
    if (messages.length === 0) {
      const ok = document.createElement('div')
      ok.style.color = 'var(--color-text-dark-secondary, #4a4)'
      ok.textContent = saveable ? 'Valid.' : ''
      el.appendChild(ok)
      return
    }
    for (const m of messages) {
      const line = document.createElement('div')
      // Errors red, advisories amber — none of the amber ones block Save.
      line.style.color = m.severity === 'error' ? 'var(--color-level-error, #c33)' : 'var(--color-level-warning, #b80)'
      line.textContent = m.message
      el.appendChild(line)
    }
  }

  async _onSave() {
    if (!this._revalidate()) {
      ui.notifications?.warn('Cannot save — the JSON is invalid or violates a Foundry rule.')
      return
    }
    const parsed = parseJson(this._cm.value)
    if (!parsed.ok) return

    const doc = this._document
    const DocClass = doc.constructor
    const desired = { ...parsed.value, _id: doc.id }
    try {
      await applyDesiredDocument(doc, DocClass, desired, { collection: doc.pack ?? null })
      ui.notifications?.info('Document saved.')
      // A type change replaced the document; re-resolve so a subsequent save targets the live one.
      const fresh = doc.pack ? await game.packs.get(doc.pack)?.getDocument(doc.id) : DocClass.get?.(doc.id)
      if (fresh) this._document = fresh
      this._cm.value = this._serialize()
      this._revalidate()
    } catch (err) {
      if (err instanceof DocumentHealthError) {
        // The load-bearing case: a doomed subclass. Nothing was written; tell the GM why.
        this._renderStatus([{ severity: 'error', message: err.message }], false)
        ui.notifications?.error('Not saved — the document would not open in Foundry. See the editor for why.')
      } else {
        ui.notifications?.error(`Save failed: ${err?.message ?? err}`)
      }
    }
  }

  _onFormat() {
    const res = formatJsonText(this._cm.value)
    if (!res.ok) {
      ui.notifications?.warn('Cannot format while the JSON is invalid.')
      return
    }
    this._cm.value = res.text
    this._revalidate()
  }

  _onDownload() {
    const blob = new Blob([this._cm.value], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${this._document.name || this._document.documentName || 'document'}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  _onUpload() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json,.json'
    input.addEventListener('change', async () => {
      const file = input.files?.[0]
      if (!file) return
      this._cm.value = await file.text()
      this._revalidate()
    })
    input.click()
  }

  _button(label, onClick) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.style.cssText = 'padding:0.25rem 0.75rem;'
    b.addEventListener('click', onClick)
    return b
  }
}

/**
 * Open (or focus) the JSON editor for a document. Exported so the sheet-header hook and any macro
 * can share one entry point.
 */
export function openJsonEditor(document) {
  return new CfgJsonEditor(document).render(true)
}
