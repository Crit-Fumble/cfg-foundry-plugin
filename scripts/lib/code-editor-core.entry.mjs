/**
 * Build-time entry for the committed `scripts/lib/code-editor-core.js`.
 *
 * code-editor-core.js is GENERATED from this by `npm run build:code-editor` — a single,
 * self-contained ESM bundle of @crit-fumble/shared's PURE JSON-editing validators. Foundry's
 * browser can't resolve bare npm specifiers, so the plugin imports the generated local module
 * instead, exactly as it does for the scene producer (scene-json.js).
 *
 * Only the framework-free logic is bundled here — no CodeMirror. The in-Foundry editor is
 * textarea-first (owner decision), so it needs the parse/format/Foundry-rule checks and the
 * system-schema diagnostics, but not the editor widget. Syntax highlighting is a later tier.
 *
 * Rebuild from the PUBLISHED package (never a linked/unpublished cfg-shared) so the committed
 * artifact matches what ships — same prod-safety rule as build:three / build:producer.
 */
export * from '@crit-fumble/shared/code-editor/json-document'
export * from '@crit-fumble/shared/code-editor/system-schema'
