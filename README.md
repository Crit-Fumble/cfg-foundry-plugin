# Crit-Fumble Core — FoundryVTT module

Core platform integration for [Crit-Fumble](https://crit-fumble.com)–hosted FoundryVTT campaigns. Provides quest sync, party roster, session tracking, AI narration, and system-aware feature gating.

- **Module ID:** `crit-fumble-core`
- **Compatibility:** FoundryVTT v13–v14
- **Manifest:** `https://raw.githubusercontent.com/Crit-Fumble/cfg-foundry-plugin/main/module.json`

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

The default `module.json` self-distributes from this GitHub repo (`manifest` →
`raw.githubusercontent.com/.../main/module.json`, `download` → the repo archive
zip). If you're running your own Crit-Fumble Core stack and want Foundry's update
check to pull your build (not ours), edit these fields in `module.json` before
packaging:

1. **`manifest`:** the URL Foundry polls for updates — point it at your fork's
   `raw.githubusercontent.com/<you>/.../main/module.json` (or your own host).
   This **must** be your domain so self-hosted Foundry instances install your
   zip, not ours.
2. **`download`:** the zip Foundry fetches on install — your fork's archive URL.
3. **`url`** and **`authors[0].url`:** `https://crit-fumble.com` — point them at
   your own site if you want.

`npm run build:zip` copies these URLs verbatim into the generated
`dist/module.json` (it no longer hardcodes any endpoint), so once you've edited
`module.json` there's nothing else to change — Foundry's "Install Module" flow
picks up whatever you set.

There is **no `MANIFEST_URL` env var override today** — forks edit the JSON and
`scripts/build-zip.js` directly. Trademark restrictions still apply: see
[TRADEMARK.md](TRADEMARK.md) for what you can/can't keep in your fork's name.

## License

AGPL-3.0-only. See [LICENSE](LICENSE) and [TRADEMARK.md](TRADEMARK.md).
