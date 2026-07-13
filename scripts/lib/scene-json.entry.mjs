/**
 * Build-time entry for the committed `scripts/services/overlay3d/scene-json.js`.
 *
 * scene-json.js is GENERATED from this by `npm run build:producer` — a single,
 * self-contained ESM bundle of @crit-fumble/shared's ONE Foundry-scene producer
 * (vtt-viewer/producer). overlay-3d.js keeps importing it as a LOCAL module, since
 * Foundry's browser can't resolve bare npm specifiers. The source of truth for the
 * builders is cfg-shared/src/vtt-viewer/producer.ts; this file just re-exports it so
 * the plugin and the offline/PlayTable adapter shape scenes through identical code.
 *
 * Rebuild from the PUBLISHED package (never a linked/unpublished cfg-shared) so the
 * committed artifact matches what ships — same prod-safety rule as build:three.
 */
export * from '@crit-fumble/shared/vtt-viewer/producer'
