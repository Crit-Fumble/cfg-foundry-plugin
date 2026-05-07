#!/usr/bin/env node
/**
 * Foundry plugin manifest + zip builder (#531)
 *
 * Foundry's update-check fetches the URL in module.json `manifest`. Today that
 * URL hits Next.js and returns HTML, breaking every world load with
 * `Unexpected token '<'`. This script produces:
 *
 *   apps/core-browser/public/foundry/modules/crit-fumble-core/
 *     module.json                            ← copy of plugin manifest
 *     crit-fumble-core-<version>.zip         ← downloadable plugin bundle
 *
 * Next.js serves files in /public verbatim with the right Content-Type, so
 * Foundry sees `application/json` for the manifest and `application/zip` for
 * the download.
 *
 * No third-party deps — uses Node's built-in zlib for DEFLATE and a hand-rolled
 * minimum-viable ZIP writer. Foundry only needs the standard local-file +
 * central-directory layout.
 *
 * Run from anywhere — paths resolve relative to this file:
 *   node packages/foundry-plugin/scripts/build-zip.js
 *
 * NOTE: this file lives next to the plugin runtime source (scripts/module.js)
 * but is excluded from the zip via PACK_EXCLUDES. Foundry will not load it
 * because module.json `esmodules` lists module.js explicitly.
 */

import { readFileSync, writeFileSync, statSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { resolve, relative, join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { deflateRawSync } from 'zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..') // packages/foundry-plugin
const REPO_ROOT = resolve(PLUGIN_ROOT, '..', '..')
const PUBLIC_OUT = resolve(REPO_ROOT, 'apps/core-browser/public/foundry/modules/crit-fumble-core')

// Files / dirs Foundry needs at runtime. Anything else (tests, docs, the build
// script itself, package-lock.json) stays out of the zip.
const PACK_DIRS = ['scripts', 'styles', 'lang']
const PACK_FILES = ['module.json']
const PACK_EXCLUDES = new Set([
  'scripts/build-zip.js', // this file
])

// ── Manifest ────────────────────────────────────────────────────────────────

const manifestRaw = readFileSync(resolve(PLUGIN_ROOT, 'module.json'), 'utf8')
const manifest = JSON.parse(manifestRaw)
const version = manifest.version
if (!version) throw new Error('module.json is missing "version"')

// ── Walk + collect files ────────────────────────────────────────────────────

function walk(dir, prefix = '') {
  const out = []
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    const rel = prefix ? `${prefix}/${name}` : name
    if (PACK_EXCLUDES.has(rel)) continue
    const st = statSync(abs)
    if (st.isDirectory()) {
      out.push(...walk(abs, rel))
    } else if (st.isFile()) {
      out.push({ abs, rel })
    }
  }
  return out
}

const entries = []
for (const file of PACK_FILES) {
  entries.push({ abs: resolve(PLUGIN_ROOT, file), rel: file })
}
for (const dir of PACK_DIRS) {
  const root = resolve(PLUGIN_ROOT, dir)
  if (!existsSync(root)) continue
  entries.push(...walk(root, dir))
}

// Foundry expects the zip to expand into a folder named after the module id.
// We add that prefix here so users can drop the zip straight into Data/modules/.
const ZIP_PREFIX = manifest.id

// ── ZIP writer (PKZIP local + central directory, DEFLATE only, no ZIP64) ────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosTime(date) {
  const t =
    ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f)
  const d =
    (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f)
  return { time: t, date: d }
}

function buildZip(files) {
  const localChunks = []
  const centralChunks = []
  let offset = 0

  // Use a fixed timestamp so the zip is reproducible across builds.
  const stamp = dosTime(new Date('2026-01-01T00:00:00Z'))

  for (const file of files) {
    const nameStr = `${ZIP_PREFIX}/${file.rel}`
    const nameBuf = Buffer.from(nameStr, 'utf8')
    const raw = readFileSync(file.abs)
    const compressed = deflateRawSync(raw, { level: 9 })
    const crc = crc32(raw)
    const useDeflate = compressed.length < raw.length
    const payload = useDeflate ? compressed : raw
    const method = useDeflate ? 8 : 0

    // Local file header (30 bytes + name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(stamp.time, 10)
    local.writeUInt16LE(stamp.date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra len
    localChunks.push(local, nameBuf, payload)

    // Central directory header (46 bytes + name)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0, 8) // flags
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(stamp.time, 12)
    central.writeUInt16LE(stamp.date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // extra len
    central.writeUInt16LE(0, 32) // comment len
    central.writeUInt16LE(0, 34) // disk number
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42)
    centralChunks.push(central, nameBuf)

    offset += local.length + nameBuf.length + payload.length
  }

  const centralStart = offset
  const centralBuf = Buffer.concat(centralChunks)

  // End of central directory record
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4) // disk
  eocd.writeUInt16LE(0, 6) // central disk
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(centralStart, 16)
  eocd.writeUInt16LE(0, 20) // comment len

  return Buffer.concat([...localChunks, centralBuf, eocd])
}

// ── Write outputs ───────────────────────────────────────────────────────────

mkdirSync(PUBLIC_OUT, { recursive: true })

const zipName = `crit-fumble-core-${version}.zip`
const zipPath = join(PUBLIC_OUT, zipName)
const manifestOut = join(PUBLIC_OUT, 'module.json')

// Public manifest: same as the source manifest, with `download` pointing at
// the zip we just built. Keep `manifest` self-referential so Foundry's update
// check loops back here.
const publicManifest = {
  ...manifest,
  download: `https://core.crit-fumble.com/foundry/modules/crit-fumble-core/${zipName}`,
}

const zipBuf = buildZip(entries)
writeFileSync(zipPath, zipBuf)
writeFileSync(manifestOut, JSON.stringify(publicManifest, null, 2) + '\n')

const sizeKb = (zipBuf.length / 1024).toFixed(1)
console.log(`[build-zip] wrote ${entries.length} files into ${relative(REPO_ROOT, zipPath)} (${sizeKb} KB)`)
console.log(`[build-zip] wrote manifest to ${relative(REPO_ROOT, manifestOut)}`)
