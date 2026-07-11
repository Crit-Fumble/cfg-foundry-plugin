/**
 * Build-time entry for the bundled three.js artifact.
 *
 * Produces the committed `scripts/lib/three.bundle.js` (a single, minified,
 * self-contained ESM file with the three.js namespace + OrbitControls +
 * GLTFLoader + the shared vtt-viewer render core) via:
 *
 *   npm run build:three
 *
 * `three` is a devDependency so the version is pinned and reproducible. Foundry
 * never loads this entry — only the built `three.bundle.js`, which the 3D
 * overlay service imports lazily on first toggle. `createViewer` doesn't
 * import 'three' itself (THREE is injected — see @crit-fumble/shared's
 * vtt-viewer core doc comment), so bundling it here adds no extra three.js
 * copy, just the render-core functions.
 */
export * as THREE from 'three'
export { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
export { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
export { createViewer } from '@crit-fumble/shared/vtt-viewer/core'
export { createViewerControls } from '@crit-fumble/shared/vtt-viewer/controls'
