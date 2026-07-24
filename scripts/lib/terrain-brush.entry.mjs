/**
 * Build-time entry for the committed `scripts/services/overlay3d/terrain-brush.js`.
 *
 * terrain-brush.js is GENERATED from this by `npm run build:terrain-brush` — a single, self-contained
 * ESM bundle of @crit-fumble/shared's pure sculpt-brush math (vtt-viewer/terrain-brush). overlay-3d.js
 * keeps importing it as a LOCAL module, since Foundry's browser can't resolve bare npm specifiers. The
 * source of truth is cfg-shared/src/vtt-viewer/terrain-brush.ts, so the plugin and the core-browser
 * PlayTable editor sculpt through identical code — no hand-maintained duplicate.
 *
 * Rebuild from the PUBLISHED package (never a linked/unpublished cfg-shared) so the committed artifact
 * matches what ships — same prod-safety rule as build:producer / build:three.
 */
export * from '@crit-fumble/shared/vtt-viewer/terrain-brush'
