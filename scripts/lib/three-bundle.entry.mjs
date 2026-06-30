/**
 * Build-time entry for the bundled three.js artifact.
 *
 * Produces the committed `scripts/lib/three.bundle.js` (a single, minified,
 * self-contained ESM file with the three.js namespace + OrbitControls) via:
 *
 *   npm run build:three
 *
 * `three` is a devDependency so the version is pinned and reproducible. Foundry
 * never loads this entry — only the built `three.bundle.js`, which the 3D
 * overlay service imports lazily on first toggle.
 */
export * as THREE from 'three'
export { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
