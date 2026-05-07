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

## License

AGPL-3.0-only. See [LICENSE](LICENSE) and [TRADEMARK.md](TRADEMARK.md).
