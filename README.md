# Crit-Fumble Core — FoundryVTT module

> # ⛔ SUPERSEDED — this repo no longer ships the module
>
> `crit-fumble-core` now ships from **[cfg-server-foundryvtt](https://github.com/Crit-Fumble/cfg-server-foundryvtt)**
> (`module/`), released as `v*` tags with `module.json` + `module.zip` as release assets.
> Production has run **3.0.0 from that channel since 2026-08-07**.
>
> The 3D view-skin, terrain sculpting and camera controls moved the other way, into
> **cfg-app-playtable** as the separate `cfg-playtable` module — one repo per surface, with a
> per-host adapter for each client (FoundryVTT now; TaleSpire and Tabletop Simulator next).
> That was the cb#132 audience split: this repo kept only what CFG-*hosted* instances need,
> and everything portable went where self-hosters can eventually reach it.
>
> **What is left here is history, plus one working part:** `module.json` is now a *pointer*.
> It advertises version 3.0.0 and a `download` on the new channel, so any Foundry still
> polling the old `raw.githubusercontent.com` manifest upgrades itself onto
> cfg-server-foundryvtt and never comes back here. Do not "fix" it to describe this repo's
> code — migrating those installs is the only job it has left.
>
> Nothing here should receive new work. Open an issue on the repo that owns the code.

- **Module ID:** `crit-fumble-core`
- **Compatibility:** FoundryVTT v13–v14
- **Manifest (legacy, redirects):** `https://raw.githubusercontent.com/Crit-Fumble/cfg-foundry-plugin/main/module.json`
- **Manifest (current):** `https://github.com/Crit-Fumble/cfg-server-foundryvtt/releases/latest/download/module.json`

## Documentation

- [API-REFERENCE.md](API-REFERENCE.md) — module API surface
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
