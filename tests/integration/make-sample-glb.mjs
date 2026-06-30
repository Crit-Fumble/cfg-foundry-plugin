/**
 * make-sample-glb.mjs — generate a tiny sample GLB for verifying 3D model
 * loading in the overlay. Produces tests/fixtures/sample-tree.glb (a low-poly
 * "tree": brown trunk + green cone). Run once:
 *
 *   node tests/integration/make-sample-glb.mjs
 *
 * Uses three's GLTFExporter — the same glTF/GLB format Blender exports natively.
 */
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const out = join(__dirname, '../fixtures/sample-tree.glb')

// GLTFExporter expects the browser FileReader (it uses addEventListener
// 'loadend') — minimal node event-emitter polyfill.
if (!globalThis.FileReader) {
  globalThis.FileReader = class {
    constructor() {
      this._l = {}
    }
    addEventListener(t, fn) {
      ;(this._l[t] ||= []).push(fn)
    }
    _emit(t) {
      const ev = { target: this, type: t }
      this['on' + t]?.(ev)
      ;(this._l[t] || []).forEach((fn) => fn(ev))
    }
    _read(blob, xf) {
      Promise.resolve(blob.arrayBuffer()).then(
        (ab) => {
          this.result = xf(ab)
          this._emit('load')
          this._emit('loadend')
        },
        (e) => {
          this.error = e
          this._emit('error')
          this._emit('loadend')
        },
      )
    }
    readAsArrayBuffer(blob) {
      this._read(blob, (ab) => ab)
    }
    readAsDataURL(blob) {
      this._read(blob, (ab) => `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(ab).toString('base64')}`)
    }
  }
}

const scene = new THREE.Scene()
const trunk = new THREE.Mesh(
  new THREE.CylinderGeometry(0.18, 0.24, 0.9, 8),
  new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 0.9 }),
)
trunk.position.y = 0.45
const leaves = new THREE.Mesh(
  new THREE.ConeGeometry(0.7, 1.5, 8),
  new THREE.MeshStandardMaterial({ color: 0x2f8f3a, roughness: 0.8 }),
)
leaves.position.y = 1.5
scene.add(trunk, leaves)

try {
  const result = await new GLTFExporter().parseAsync(scene, { binary: true })
  const buf = Buffer.from(result)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, buf)
  console.log('wrote', out, buf.length, 'bytes')
} catch (err) {
  console.error('GLTF export failed:', err)
  process.exit(1)
}
