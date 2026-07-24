/**
 * Build-time entry for `scripts/services/overlay3d/terrain-stamp.js` — the shared, framework-free
 * TerrainStampController (@crit-fumble/shared vtt-viewer/terrain-stamp). overlay-3d.js imports it as a
 * LOCAL module so the plugin drives the identical Level Stamp behaviour as PlayTable. Source of truth
 * is cfg-shared/src/vtt-viewer/terrain-stamp.ts. Rebuild from the PUBLISHED package before a release.
 */
export * from '@crit-fumble/shared/vtt-viewer/terrain-stamp'
// Shared heightmap-performance warning COPY, so the caution reads identically in PlayTable and here.
export * from '@crit-fumble/shared/constants/terrain-warnings'
