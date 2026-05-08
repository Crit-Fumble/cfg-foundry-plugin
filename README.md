# Crit-Fumble Core — FoundryVTT module

Core platform integration for [Crit-Fumble](https://crit-fumble.com)–hosted FoundryVTT campaigns. Provides quest sync, party roster, session tracking, AI narration, and system-aware feature gating.

- **Module ID:** `crit-fumble-core`
- **Compatibility:** FoundryVTT v13–v14
- **Manifest:** `https://core.crit-fumble.com/foundry/modules/crit-fumble-core/module.json`

## Documentation

- [API-REFERENCE.md](API-REFERENCE.md) — module API surface
- [TABLE-SYNC-IMPLEMENTATION.md](TABLE-SYNC-IMPLEMENTATION.md) — sync architecture
- [docs/](docs/) — additional guides

## Development

```bash
npm install
npm test                  # unit tests (jest)
npm run test:foundry:up   # boot foundry stack for integration tests
npm run test:foundry      # run playwright integration tests
npm run test:foundry:down # tear down
npm run build:zip         # package for distribution
```

## Environment

No env vars are needed to install, load, or build the module. The
[`.env.example`](.env.example) at the repo root is a pointer; integration tests
load credentials from `tests/.env.test`. Copy
[`tests/.env.test.example`](tests/.env.test.example) to `tests/.env.test` and
fill it in before running `npm run test:foundry:up`.

## Self-hosting / forking

The default `module.json` points at the CFG-hosted manifest endpoint. If you're
running your own Crit-Fumble Core stack and want Foundry's update check to pull
your build (not ours), edit the manifest URLs before packaging:

1. **`module.json` (line ~9):** `authors[0].url` is `https://crit-fumble.com` —
   point it at your own site if you want.
2. **`module.json` (line ~27):** `url` is `https://crit-fumble.com` — same idea.
3. **`module.json` (line ~28):** `manifest` is
   `https://core.crit-fumble.com/foundry/modules/crit-fumble-core/module.json`.
   This is the URL Foundry hits to check for updates and **must** point at your
   domain so self-hosted Foundry instances install your zip, not ours.
4. **`scripts/build-zip.js` (line ~199):** the `download` URL written into the
   public `module.json` is hardcoded to `https://core.crit-fumble.com/...`.
   Edit the `download` template to match your domain, or post-process the
   generated `module.json` after `npm run build:zip`.

Then run `npm run build:zip` to produce a distributable zip + manifest pair in
`public/` — host both files behind the URLs you set above and Foundry's "Install
Module" flow will pick them up.

There is **no `MANIFEST_URL` env var override today** — forks edit the JSON and
`scripts/build-zip.js` directly. Trademark restrictions still apply: see
[TRADEMARK.md](TRADEMARK.md) for what you can/can't keep in your fork's name.

## License

AGPL-3.0-only. See [LICENSE](LICENSE) and [TRADEMARK.md](TRADEMARK.md).
