# Contributing to crit-fumble-core (Foundry module)

Thanks for your interest in contributing. This is the FoundryVTT module that
integrates a Foundry world with the Crit-Fumble platform.

## Local dev setup

You need:

- **Node.js** (recent LTS works; the unit suite runs under
  `--experimental-vm-modules`)
- **Docker** (only for the Foundry-container integration tests)

```bash
# Clone, then:
npm install
```

There are no environment variables required to run the unit tests. The
integration tests against a real Foundry server are configured under
`tests/.env.test` — copy from `tests/.env.test.example` if you plan to run them.

The module ships as plain JavaScript ESM under `scripts/`, `lang/`, `styles/`,
and `module.json`. There is no transpile step for the source — `npm run
build:zip` simply packages those files for distribution.

## Running tests

```bash
npm test                    # Jest unit tests (the default suite)
npm run test:watch          # Jest in watch mode
npm run test:coverage       # Jest with coverage report

# Integration tests against a real Foundry container:
npm run test:foundry:up     # Spin up Foundry via docker compose
npm run test:foundry        # Run Playwright tests against the live server
npm run test:foundry:down   # Tear down

npm run test:foundry:all    # up → test → down (handy one-shot)
```

The `pre-push` Husky hook runs `npm test` and will block pushes on a red
unit suite. Don't bypass with `--no-verify`.

## Building a release artifact

```bash
npm run build:zip   # emits a versioned zip suitable for the Foundry manifest
```

## Code conventions

- **No transpile step** — write plain ESM JavaScript that Foundry can load
  directly. Use `import { ... } from './foo.js'` (always with the `.js`
  extension; Foundry's loader is unforgiving).
- **File size:** 800 lines hard maximum. Split before you exceed it.
- **Foundry compatibility:** target Foundry v13–v14 as declared in
  `module.json`. Don't depend on private internals if a hook or document API
  exists.
- **No external runtime dependencies.** The module is shipped as a static
  bundle; everything must be loadable by Foundry without an installer.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/). Type
prefixes: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`, `build`,
`perf`, `style`, `revert`. Keep the subject lower-case and under ~100 chars.

Examples:

```
feat: sync Foundry initiative tracker with platform sessions
fix: handle missing token actor in dice-roll handler
docs: clarify api-reference for hook ordering
```

## Submitting a pull request

1. **Fork** the repo and branch from `next` (the release-candidate branch):
   `git checkout -b feat/your-change`
2. **Write tests** for new behavior. Keep the existing suite green.
3. **Run locally** before pushing: `npm test`. If your change touches
   server-side hooks or sync code, also run the Foundry integration tests.
4. **Commit** using Conventional Commits.
5. **Open a PR** against `next` (never `main` — it is released truth and is
   only ever fast-forwarded to). Describe the *why*, screenshots/clips help
   for UI changes. Link any related issues.
6. **Be patient and responsive** during review.

## License

Contributions are accepted under [AGPL-3.0-only](LICENSE). By submitting a PR
you agree your contribution may be distributed under that license. See
[NOTICE](NOTICE) and [TRADEMARK.md](TRADEMARK.md) for attribution and
trademark policy.
