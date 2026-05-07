/**
 * Playwright globalTeardown — runs once after all integration tests.
 * Currently a no-op; extend here for test data cleanup if needed.
 */
export default async function globalTeardown() {
  // No teardown required — the Foundry container is managed separately
  // via npm run test:foundry:down (docker compose down).
}
