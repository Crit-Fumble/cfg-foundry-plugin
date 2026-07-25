/**
 * CFG Sourcebook Shelf — the FoundryVTT shell for compendium PDF entries (dt#253).
 *
 * Lists the PDF sourcebooks in the linked campaigns' scoped compendiums and opens each in
 * a reader window whose render is DELIBERATELY STUBBED: the page renderer belongs to
 * cfg-core-server#212 (license-friendly, non-download — pages raster server-side and only
 * images ever reach a client), and the owner's instruction is "don't complete" that work.
 *
 * What this ships is the CONTRACT: a real <canvas> that cs#212 paints pages onto. The
 * canvas sizing/clear/redraw path is exercised now so the renderer slots in without
 * re-plumbing the surface. Nothing here fetches PDF bytes, and no URL exists to leak —
 * the server exposes metadata only ({ fileName, byteSize, pageCount }); the read presign
 * is server-side, for the rasterizer.
 *
 * Follows CfgJsonEditor's ApplicationV2 pattern; reached from a DOM-injected button on
 * the Journal directory (the header-control API dispatches named actions to the owning
 * app and has no onClick — see json-editor-header-button.js for the verified reasoning).
 */

'use strict'

const { ApplicationV2 } = foundry.applications.api

const LOG = 'CFG Core | Sourcebooks |'

export class CfgSourcebookShelf extends ApplicationV2 {
  /**
   * @param {import('../clients/api-client.js').CoreAPIClient} apiClient
   * @param {string[]} campaignIds — the linked campaigns to list sourcebooks from
   */
  constructor(apiClient, campaignIds, options = {}) {
    super(options)
    this._api = apiClient
    this._campaignIds = campaignIds
    this._books = null // null = loading; [] = none
  }

  static DEFAULT_OPTIONS = {
    id: 'cfg-sourcebook-shelf',
    tag: 'div',
    window: { title: 'Sourcebooks', icon: 'fa-solid fa-book', resizable: true },
    position: { width: 720, height: 560 },
    classes: ['themed', 'cfg-app', 'cfg-sourcebook-shelf'],
  }

  /* -------------------------------------------- */

  async _renderHTML() {
    const root = document.createElement('div')
    root.style.cssText = 'display:flex; height:100%; gap:0.75rem; padding:0.75rem;'

    const list = document.createElement('div')
    list.style.cssText = 'flex:0 0 220px; overflow-y:auto; display:flex; flex-direction:column; gap:0.25rem;'
    list.dataset.role = 'book-list'

    const readerWrap = document.createElement('div')
    readerWrap.style.cssText = 'flex:1; min-width:0; display:flex; flex-direction:column; gap:0.5rem;'

    const meta = document.createElement('div')
    meta.dataset.role = 'book-meta'
    meta.style.cssText = 'font-size:0.8rem; opacity:0.8; min-height:1.2em;'
    meta.textContent = 'Select a sourcebook.'

    const canvasHost = document.createElement('div')
    canvasHost.style.cssText = 'flex:1; min-height:0; overflow-y:auto; background:rgba(0,0,0,0.25); border-radius:4px; padding:0.5rem;'
    const canvas = document.createElement('canvas')
    canvas.dataset.role = 'sourcebook-canvas'
    canvas.style.cssText = 'display:block; margin:0 auto; border-radius:2px; box-shadow:0 2px 8px rgba(0,0,0,0.4);'
    canvasHost.appendChild(canvas)

    readerWrap.append(meta, canvasHost)
    root.append(list, readerWrap)

    this._listEl = list
    this._metaEl = meta
    this._canvas = canvas

    void this._loadBooks()
    return root
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result)
  }

  /* -------------------------------------------- */

  async _loadBooks() {
    const books = []
    for (const campaignId of this._campaignIds) {
      try {
        const { compendiums } = await this._api.get(`/api/v1/player/campaigns/${campaignId}/compendiums?scope=campaign`)
        for (const pack of compendiums ?? []) {
          const detail = await this._api.get(`/api/v1/player/campaigns/${campaignId}/compendiums/${pack.id}/entries`)
          for (const entry of detail?.entries ?? []) {
            if (entry.format === 'pdf') books.push({ campaignId, packId: pack.id, packName: pack.name, ...entry })
          }
        }
      } catch (err) {
        console.debug?.(`${LOG} campaign ${campaignId} skipped:`, err?.message || err)
      }
    }
    this._books = books
    this._renderList()
  }

  _renderList() {
    const list = this._listEl
    if (!list) return
    list.replaceChildren()
    if (!this._books?.length) {
      const empty = document.createElement('p')
      empty.style.cssText = 'opacity:0.6; font-size:0.8rem;'
      empty.textContent = this._books === null ? 'Loading…' : 'No sourcebooks shared with your campaigns yet.'
      list.appendChild(empty)
      return
    }
    for (const book of this._books) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.style.cssText = 'text-align:left; padding:0.35rem 0.5rem; border-radius:4px;'
      btn.textContent = book.name
      btn.title = `${book.packName}`
      btn.addEventListener('click', () => this._openBook(book))
      list.appendChild(btn)
    }
  }

  async _openBook(book) {
    try {
      const entry = await this._api.get(
        `/api/v1/player/campaigns/${book.campaignId}/compendiums/${book.packId}/entries/${book.id}`,
      )
      const pdf = entry?.pdf
      const mb = pdf ? (pdf.byteSize / (1024 * 1024)).toFixed(1) : '?'
      this._metaEl.textContent = pdf
        ? `${entry.name} — ${pdf.fileName} · ${mb} MB${pdf.pageCount != null ? ` · ${pdf.pageCount} pages` : ''}`
        : entry?.name ?? book.name
      this._paintStub()
    } catch (err) {
      this._metaEl.textContent = `Could not open: ${err?.message || err}`
    }
  }

  /**
   * The "coming soon" page — painted IN the canvas so the exact element and draw path
   * cs#212 will use is exercised from day one. The renderer replaces this method's body
   * with a server-rastered page image; everything around it stays.
   */
  _paintStub() {
    const canvas = this._canvas
    const host = canvas?.parentElement
    if (!canvas || !host) return
    const w = Math.max(320, host.clientWidth - 16)
    const h = Math.round(w * 1.294) // US-letter-ish
    canvas.width = w
    canvas.height = h
    const g = canvas.getContext('2d')
    if (!g) return
    g.fillStyle = '#f5f2ea'
    g.fillRect(0, 0, w, h)
    g.strokeStyle = 'rgba(0,0,0,0.15)'
    g.strokeRect(0.5, 0.5, w - 1, h - 1)
    g.fillStyle = 'rgba(30,30,40,0.6)'
    g.textAlign = 'center'
    g.font = '600 15px system-ui, sans-serif'
    g.fillText('Sourcebook reader coming soon', w / 2, h / 2 - 10)
    g.font = '400 12px system-ui, sans-serif'
    g.fillText('Pages will render here without downloading the file', w / 2, h / 2 + 12)
  }
}

/* -------------------------------------------- */

const BUTTON_CLASS = 'cfg-sourcebook-shelf-btn'

/**
 * Register the "Sourcebooks" button on the Journal directory. Same DOM-injection approach
 * (and reasoning) as the JSON-editor header button: render hooks re-fire on every
 * re-render, so a dedup guard prevents duplicates.
 */
export function registerSourcebookShelfButton(apiClient, getLinkedCampaignIds) {
  const inject = (element) => {
    const el = element instanceof HTMLElement ? element : element?.[0]
    if (!el || el.querySelector(`.${BUTTON_CLASS}`)) return
    // v13/v14 directory headers differ; fall back to the element itself so the button
    // lands SOMEWHERE visible rather than silently nowhere.
    const header =
      el.querySelector('.directory-header .header-actions') ??
      el.querySelector('.directory-header') ??
      el.querySelector('header') ??
      el

    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = BUTTON_CLASS
    btn.innerHTML = '<i class="fa-solid fa-book"></i> Sourcebooks'
    btn.addEventListener('click', () => {
      const campaignIds = getLinkedCampaignIds() ?? []
      new CfgSourcebookShelf(apiClient, campaignIds).render(true)
    })
    header.appendChild(btn)
  }

  Hooks.on('renderJournalDirectory', (_app, element) => {
    try {
      inject(element)
    } catch (err) {
      // A directory we could not decorate must never break its render.
      console.debug?.(`${LOG} button skipped:`, err?.message || err)
    }
  })

  // The Journal directory renders during BOOT, before the ready hook registers the
  // listener above — so the initial render is already gone by the time we are called.
  // Verified live: without this, the button only appears after some later re-render.
  try {
    if (ui.journal?.element) inject(ui.journal.element)
  } catch (err) {
    console.debug?.(`${LOG} initial inject skipped:`, err?.message || err)
  }
}
