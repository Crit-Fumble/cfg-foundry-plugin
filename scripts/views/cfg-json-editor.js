/**
 * CFG JSON Editor — raw document JSON editing inside Foundry, at parity with PlayTable's editor
 * (dt#212 parity). Reached from a header button on Item / Actor / JournalEntry sheets, including
 * documents opened from a compendium.
 *
 * Textarea-first by owner decision: this ships the VALIDATION that makes the editor worth having —
 * the same discard warning, required-but-empty error and pre-save health probe PlayTable runs —
 * without pulling CodeMirror into the plugin bundle. Syntax highlighting is a later tier.
 *
 * The diagnostics come from the shared code-editor core, bundled for Foundry as
 * `scripts/lib/code-editor-core.js`. The save goes through the SAME `applyDesiredDocument` the
 * compendium write-back uses, so a type change, a field removal and a doomed document behave
 * identically here and there.
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
    this._textarea = null
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

    const textarea = document.createElement('textarea')
    textarea.value = this._serialize()
    textarea.spellcheck = false
    textarea.style.cssText =
      'flex:1; width:100%; resize:none; font-family:var(--font-mono, monospace); font-size:0.85rem; ' +
      'white-space:pre; overflow:auto; padding:0.5rem; border:1px solid var(--color-border-light-tertiary,#888); border-radius:4px;'
    textarea.addEventListener('input', () => this._revalidate())
    this._textarea = textarea
    root.appendChild(textarea)

    const status = document.createElement('div')
    status.style.cssText = 'min-height:2.5rem; font-size:0.8rem; display:flex; flex-direction:column; gap:0.15rem;'
    this._statusEl = status
    root.appendChild(status)

    return root
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result)
  }

  async _onRender() {
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
    const text = this._textarea?.value ?? ''
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
    const parsed = parseJson(this._textarea.value)
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
      this._textarea.value = this._serialize()
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
    const res = formatJsonText(this._textarea.value)
    if (!res.ok) {
      ui.notifications?.warn('Cannot format while the JSON is invalid.')
      return
    }
    this._textarea.value = res.text
    this._revalidate()
  }

  _onDownload() {
    const blob = new Blob([this._textarea.value], { type: 'application/json' })
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
      this._textarea.value = await file.text()
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
