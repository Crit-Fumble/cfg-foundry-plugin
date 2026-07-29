/**
 * Build-time entry for `scripts/lib/react-panel.js` — a self-contained ESM bundle of React +
 * ReactDOM + @crit-fumble/react's terrain panel, plus a tiny mount/update/unmount helper. Foundry's
 * browser can't resolve bare npm specifiers, so overlay-3d.js imports the BUILT bundle as a LOCAL
 * module (same pattern as three.bundle.js / scene-json.js).
 *
 * This is the plugin's ONE React instance — bundled here once. cfg-react takes React as a PEER, so
 * there is never a second copy. React is UI-only: this bundle imports neither `three` nor
 * @crit-fumble/shared, so it stays small and independent of three.bundle.js.
 *
 * MUST be built with `process.env.NODE_ENV` DEFINED (React reads it at runtime; it's undefined in a
 * browser bundle otherwise → `process is not defined`). See `build:react-panel`. Rebuild from the
 * PUBLISHED @crit-fumble/react before a release — same prod-safety rule as the other bundles.
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { TerrainToolPanel, TerrainElevationPill, CameraModeSwitcher, SeatSlider } from '@crit-fumble/react'

export { TerrainToolPanel, TerrainElevationPill, CameraModeSwitcher, SeatSlider }

/**
 * Mount a cfg-react component into `container` and return handles. `update(nextProps)` re-renders with
 * new props (call on state change); `unmount()` tears the React root down (call when the overlay hides
 * — no leaked roots). Lifecycle-bound mounting keeps React's memory footprint tied to the overlay's.
 *
 * NOTE: the container element is OURS — Foundry re-renders its scene-controls DOM often, so the host
 * keeps this node and re-APPENDS it (a move, not a recreate), which leaves the React root intact.
 */
function mountComponent(Component, container, props) {
  const root = createRoot(container)
  root.render(createElement(Component, props))
  return {
    update: (nextProps) => root.render(createElement(Component, nextProps)),
    unmount: () => root.unmount(),
  }
}

/** The terrain tool RAIL — hosted inside Foundry's native scene-controls tool column. */
export function mountTerrainPanel(container, props) {
  return mountComponent(TerrainToolPanel, container, props)
}

/** The elevation READOUT — floats over the 3D view (the tool column is too narrow for it). */
export function mountElevationPill(container, props) {
  return mountComponent(TerrainElevationPill, container, props)
}

/** The camera-mode bar — hosted above Foundry's hotbar while the 3D overlay is up. */
export function mountCameraSwitcher(container, props) {
  return mountComponent(CameraModeSwitcher, container, props)
}

/** The SEAT slider — stacked above the camera bar while a tabletop seat is active. */
export function mountSeatSlider(container, props) {
  return mountComponent(SeatSlider, container, props)
}
