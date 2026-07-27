/**
 * CFG Module-Pack Import Sync (dt#185) — drains the platform's module-pack import queue.
 *
 * A GM in PlayTable asks for an installed module/system pack (the free SRD packages) to be
 * imported into a scoped compendium. The platform cannot read pack LevelDB while this world
 * runs, so the request queues and THIS service carries the content across: each tick the
 * elected reporter lists pending requests for this world, reads each pack via
 * `game.packs.get('<packageId>.<packName>')`, and pushes the documents back in batches.
 *
 * The licensing gate lives SERVER-SIDE (a config allowlist, re-checked on every push) — this
 * client is a courier, not the gate. A pack this world does not have parks the request with an
 * error rather than retrying forever.
 *
 * Same single-reporter election as the compendium write-back next door: exactly one connected
 * GM client does the work.
 */

'use strict'

const LOG = 'CFG Core | ModulePackImport |'
const TICK_MS = 60_000
const SERVICE_GM_ID = 'cfgservicegm0001'
/** Docs per push — the server caps at 500; 200 keeps a batch of big SRD items well under the 16MB body limit. */
const BATCH_SIZE = 200

export class ModulePackImportSync {
  /**
   * @param {import('../clients/api-client.js').CoreAPIClient} apiClient
   * @param {string} installationId
   */
  constructor(apiClient, installationId) {
    this._api = apiClient
    this._installationId = installationId
    this._worldId = game.world?.id ?? null
    this._handle = null
    this._running = false
    this._busy = false
  }

  start() {
    if (!this._worldId || !this._installationId) return
    this._running = true
    this._tick().catch((err) => console.debug?.(`${LOG} initial tick skipped:`, err?.message || err))
    this._handle = setInterval(() => {
      this._tick().catch((err) => console.debug?.(`${LOG} tick skipped:`, err?.message || err))
    }, TICK_MS)
    console.log(`${LOG} started for world ${this._worldId}`)
  }

  stop() {
    this._running = false
    if (this._handle) {
      clearInterval(this._handle)
      this._handle = null
    }
  }

  /** Elected reporter id: smallest human-GM id, or the lone service-GM. */
  _electedReporterId() {
    const gms = game.users.filter((u) => u.active && u.isGM)
    if (gms.length === 0) return null
    const humans = gms.filter((u) => u.id !== SERVICE_GM_ID)
    const pool = humans.length ? humans : gms
    return pool.map((u) => u.id).sort()[0]
  }

  _isReporter() {
    const id = this._electedReporterId()
    return !!id && game.user?.id === id
  }

  async _tick() {
    if (!this._running || this._busy || !this._isReporter()) return
    this._busy = true
    try {
      const plan = await this._api.getModulePackImportPlan(this._installationId, this._worldId)
      const requests = plan?.data ?? []
      for (const req of requests) {
        try {
          await this._fulfil(req)
        } catch (err) {
          // Per-request isolation: one unreadable pack must not strand the rest.
          console.warn(`${LOG} request ${req.requestId} failed:`, err?.message || err)
        }
      }
    } finally {
      this._busy = false
    }
  }

  /** Read one requested pack and push its documents (batched). */
  async _fulfil(req) {
    const packId = `${req.packageId}.${req.packName}`
    const pack = game.packs.get(packId)
    if (!pack) {
      await this._api.pushModulePackImport(this._installationId, {
        world: this._worldId,
        requestId: req.requestId,
        entries: [],
        done: false,
        error: `pack ${packId} is not present in this world`,
      })
      return
    }

    const docs = await pack.getDocuments()
    const folders = (pack.folders?.contents ?? []).map((f) => ({
      _id: f.id,
      name: f.name,
      color: f.color?.css ?? (typeof f.color === 'string' ? f.color : null),
      sort: f.sort ?? 0,
      folder: f.folder?.id ?? null,
    }))

    const entries = docs.map((d) => {
      const doc = d.toObject()
      return {
        _id: d.id,
        name: d.name ?? undefined,
        sort: typeof doc.sort === 'number' ? doc.sort : 0,
        folder: typeof doc.folder === 'string' ? doc.folder : null,
        doc,
      }
    })

    let applied = 0
    for (let i = 0; i < entries.length || i === 0; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE)
      const done = i + BATCH_SIZE >= entries.length
      const res = await this._api.pushModulePackImport(this._installationId, {
        world: this._worldId,
        requestId: req.requestId,
        entries: batch,
        // Folders are idempotent upserts server-side; ride the first batch only.
        ...(i === 0 && folders.length ? { folders } : {}),
        done,
      })
      applied += res?.data?.applied ?? batch.length
      if (done) break
    }
    console.log(`${LOG} imported ${packId}: ${applied} document${applied === 1 ? '' : 's'} pushed`)
  }
}
