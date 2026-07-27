/**
 * CFG Sourcebook Shelf — the FoundryVTT shell for compendium PDF entries (dt#253),
 * painting cs#212's non-download reader.
 *
 * Pages arrive as server-rastered WebP streamed through the platform endpoint
 * (`…/pdf/pages/:n.webp`) and are drawn into a <canvas> — there is never an <img src> to
 * right-click-save, never a bucket URL, and the source PDF never reaches this client.
 * Search calls the per-book endpoint (`…/pdf/search?q=`); the server searches its cached
 * text layer, so no text is bulk-shipped either. This is the ApplicationV2 twin of
 * cfg-core-browser's SourcebookReader.tsx — behaviour changes should land in both.
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

    // Reader state — one open book at a time.
    this._book = null // { campaignId, packId, entryId, name } once opened
    this._page = 1
    this._pageCount = null
    this._bitmap = null // current page ImageBitmap
    this._loading = false
    this._error = null
    this._pending = false // upload never completed — no pages exist to render
    this._loadSeq = 0 // stale-response guard for page fetches
    this._resizeObserver = null
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

    const toolbar = this._buildToolbar()

    const hits = document.createElement('div')
    hits.dataset.role = 'search-hits'
    hits.style.cssText =
      'display:none; max-height:9rem; overflow-y:auto; border:1px solid rgba(255,255,255,0.1); border-radius:4px; background:rgba(255,255,255,0.05);'

    const canvasHost = document.createElement('div')
    canvasHost.style.cssText = 'flex:1; min-height:0; overflow-y:auto; background:rgba(0,0,0,0.25); border-radius:4px; padding:0.5rem;'
    const canvas = document.createElement('canvas')
    canvas.dataset.role = 'sourcebook-canvas'
    canvas.style.cssText = 'display:block; margin:0 auto; border-radius:2px; box-shadow:0 2px 8px rgba(0,0,0,0.4);'
    canvasHost.appendChild(canvas)

    const footer = document.createElement('p')
    footer.style.cssText = 'margin:0; font-size:0.7rem; opacity:0.5;'
    footer.textContent = 'Shared with this table for reading only — the file itself never leaves the library.'

    readerWrap.append(meta, toolbar, hits, canvasHost, footer)
    root.append(list, readerWrap)

    this._listEl = list
    this._metaEl = meta
    this._hitsEl = hits
    this._canvas = canvas
    this._canvasHost = canvasHost

    void this._loadBooks()
    return root
  }

  /** Prev/next + page label + go-to + per-book search. Disabled until a book opens. */
  _buildToolbar() {
    const bar = document.createElement('div')
    bar.dataset.role = 'reader-toolbar'
    bar.style.cssText = 'display:flex; align-items:center; gap:0.4rem; flex-wrap:wrap;'

    const btn = (label, role, onClick) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.dataset.role = role
      b.textContent = label
      b.disabled = true
      b.style.cssText = 'flex:0 0 auto; width:auto; padding:0.15rem 0.5rem; font-size:0.75rem; line-height:1.4;'
      b.addEventListener('click', onClick)
      return b
    }

    const prev = btn('‹ Prev', 'page-prev', () => this._go(this._page - 1))
    const label = document.createElement('span')
    label.dataset.role = 'page-label'
    label.style.cssText = 'font-size:0.75rem; opacity:0.7; font-variant-numeric:tabular-nums;'
    label.textContent = '—'
    const next = btn('Next ›', 'page-next', () => this._go(this._page + 1))

    const jump = document.createElement('input')
    jump.type = 'text'
    jump.inputMode = 'numeric'
    jump.placeholder = 'Go to…'
    jump.setAttribute('aria-label', 'Go to page')
    jump.dataset.role = 'page-jump'
    jump.disabled = true
    jump.style.cssText = 'flex:0 0 4rem; width:4rem; font-size:0.75rem;'
    jump.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return
      const n = Number.parseInt(jump.value, 10)
      if (Number.isFinite(n)) this._go(n)
      jump.value = ''
    })

    const search = document.createElement('input')
    search.type = 'search'
    search.placeholder = 'Search this book…'
    search.setAttribute('aria-label', 'Search this book')
    search.dataset.role = 'search-input'
    search.disabled = true
    search.style.cssText = 'flex:1 1 8rem; min-width:0; font-size:0.75rem;'
    search.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') void this._runSearch()
    })

    const go = btn('Search', 'search-go', () => void this._runSearch())

    bar.append(prev, label, next, jump, search, go)
    this._prevBtn = prev
    this._nextBtn = next
    this._pageLabelEl = label
    this._jumpEl = jump
    this._searchEl = search
    this._searchBtn = go
    return bar
  }

  /** Post-connect: watch the canvas host so page renders track window resizes. */
  _onRender(context, options) {
    super._onRender?.(context, options)
    this._resizeObserver?.disconnect()
    if (this._canvasHost && typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => this._paint())
      this._resizeObserver.observe(this._canvasHost)
    }
    this._paint()
  }

  _onClose(options) {
    this._resizeObserver?.disconnect()
    this._resizeObserver = null
    this._bitmap?.close?.()
    this._bitmap = null
    super._onClose?.(options)
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

      this._book = pdf ? { campaignId: book.campaignId, packId: book.packId, entryId: book.id, name: entry.name } : null
      this._page = 1
      this._pageCount = pdf?.pageCount ?? null
      this._pending = !!pdf?.pending
      this._error = pdf ? null : 'This entry has no PDF attached.'
      this._bitmap?.close?.()
      this._bitmap = null
      this._clearHits()
      this._updateToolbar()

      if (!this._book || this._pending) {
        this._paint()
        return
      }
      // Entries that predate their first render have no pageCount yet — the meta
      // endpoint computes and persists it on first ask.
      if (this._pageCount == null) {
        void this._api
          .get(`${this._base()}/meta`)
          .then((m) => {
            if (typeof m?.pageCount === 'number') {
              this._pageCount = m.pageCount
              this._updateToolbar()
            }
          })
          .catch(() => {})
      }
      void this._loadPage()
    } catch (err) {
      this._metaEl.textContent = `Could not open: ${err?.message || err}`
    }
  }

  _base() {
    const b = this._book
    return `/api/v1/player/campaigns/${b.campaignId}/compendiums/${b.packId}/entries/${b.entryId}/pdf`
  }

  _go(n) {
    if (!this._book || this._pending) return
    const max = this._pageCount ?? Number.MAX_SAFE_INTEGER
    const target = Math.max(1, Math.min(max, Math.floor(n)))
    if (!Number.isFinite(target) || target === this._page) return
    this._page = target
    void this._loadPage()
  }

  /** Fetch the current page's WebP and swap it in. Stale responses are discarded. */
  async _loadPage() {
    const seq = ++this._loadSeq
    this._loading = true
    this._error = null
    this._updateToolbar()
    this._paint()
    try {
      const blob = await this._api.getBinary(`${this._base()}/pages/${this._page}.webp`)
      const bmp = await createImageBitmap(blob)
      if (seq !== this._loadSeq) {
        bmp.close()
        return
      }
      this._bitmap?.close?.()
      this._bitmap = bmp
      this._loading = false
    } catch (err) {
      if (seq !== this._loadSeq) return
      this._bitmap?.close?.()
      this._bitmap = null
      this._loading = false
      this._error = err?.message || 'Page failed to load'
    }
    this._updateToolbar()
    this._paint()

    // Warm the neighbours into the browser cache (the endpoint serves
    // Cache-Control: private) — fire-and-forget, rate-limit friendly.
    const total = this._pageCount ?? Infinity
    for (const n of [this._page - 1, this._page + 1]) {
      if (n >= 1 && n <= total) void this._api.getBinary(`${this._base()}/pages/${n}.webp`).catch(() => {})
    }
  }

  _updateToolbar() {
    const noBook = !this._book || this._pending
    if (this._prevBtn) this._prevBtn.disabled = noBook || this._loading || this._page <= 1
    if (this._nextBtn)
      this._nextBtn.disabled = noBook || this._loading || (this._pageCount != null && this._page >= this._pageCount)
    if (this._jumpEl) this._jumpEl.disabled = noBook
    if (this._searchEl) this._searchEl.disabled = noBook
    if (this._searchBtn) this._searchBtn.disabled = noBook || this._searching
    if (this._pageLabelEl)
      this._pageLabelEl.textContent = noBook
        ? '—'
        : `Page ${this._page}${this._pageCount != null ? ` / ${this._pageCount}` : ''}`
  }

  /**
   * DPR-aware page paint — the stub's original canvas path, now drawing a real
   * server-rastered bitmap. With no bitmap it shows the loading/error/pending state.
   */
  _paint() {
    const canvas = this._canvas
    const host = this._canvasHost
    if (!canvas || !host) return
    const bmp = this._bitmap
    const dpr = globalThis.devicePixelRatio || 1
    const w = Math.max(320, host.clientWidth - 16)
    const aspect = bmp ? bmp.height / bmp.width : 1.294 // US-letter-ish until a page lands
    const h = Math.max(120, Math.round(w * aspect))
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    const g = canvas.getContext('2d')
    if (!g) return
    g.scale(dpr, dpr)
    g.fillStyle = '#f5f2ea'
    g.fillRect(0, 0, w, h)
    if (bmp) {
      g.drawImage(bmp, 0, 0, w, h)
      return
    }
    g.fillStyle = 'rgba(30,30,40,0.6)'
    g.textAlign = 'center'
    g.font = '400 13px system-ui, sans-serif'
    const message = this._pending
      ? 'This upload never finished — re-upload the book to read it here.'
      : this._loading
        ? 'Loading page…'
        : (this._error ?? (this._book ? 'No page loaded' : 'Select a sourcebook.'))
    g.fillText(message, w / 2, h / 2)
  }

  /* ── Search ──────────────────────────────────────── */

  async _runSearch() {
    if (!this._book || this._pending) return
    const q = this._searchEl?.value.trim()
    if (!q) {
      this._clearHits()
      return
    }
    this._searching = true
    this._updateToolbar()
    try {
      const body = await this._api.get(`${this._base()}/search?q=${encodeURIComponent(q)}`)
      this._renderHits(body?.hits ?? [])
    } catch (err) {
      this._renderHits(null, err?.message || 'Search failed')
    } finally {
      this._searching = false
      this._updateToolbar()
    }
  }

  _clearHits() {
    if (!this._hitsEl) return
    this._hitsEl.replaceChildren()
    this._hitsEl.style.display = 'none'
  }

  _renderHits(hits, errorMessage = null) {
    const el = this._hitsEl
    if (!el) return
    el.replaceChildren()
    el.style.display = 'block'
    if (errorMessage || !hits?.length) {
      const p = document.createElement('p')
      p.style.cssText = 'margin:0; padding:0.4rem 0.5rem; font-size:0.75rem; opacity:0.6;'
      p.textContent = errorMessage ?? 'No matches.'
      el.appendChild(p)
      return
    }
    for (const h of hits) {
      const row = document.createElement('button')
      row.type = 'button'
      row.style.cssText =
        'display:block; width:100%; text-align:left; padding:0.3rem 0.5rem; font-size:0.75rem; line-height:1.4; border:0; border-bottom:1px solid rgba(255,255,255,0.05); border-radius:0; background:transparent;'
      row.textContent = `p.${h.page}${h.count > 1 ? ` ×${h.count}` : ''} — ${h.snippet}`
      row.addEventListener('click', () => {
        this._go(h.page)
        this._clearHits()
      })
      el.appendChild(row)
    }
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
