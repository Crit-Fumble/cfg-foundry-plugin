#!/usr/bin/env node
/**
 * Waits for the FoundryVTT container to be ready.
 * Polls GET /api/status until it responds 200 or the timeout is reached.
 *
 * Usage (standalone): node tests/integration/shared/wait-for-foundry.js
 * Also called from globalSetup.js before running tests.
 */

const FOUNDRY_URL = process.env.FOUNDRY_URL || 'http://localhost:30000'
const POLL_MS = 5_000
const TIMEOUT_MS = 180_000 // 3 minutes — image pull + boot can be slow on first run

async function waitForFoundry() {
  const start = Date.now()
  console.log(`[wait-for-foundry] Polling ${FOUNDRY_URL}/api/status ...`)

  while (Date.now() - start < TIMEOUT_MS) {
    try {
      const res = await fetch(`${FOUNDRY_URL}/api/status`)
      if (res.ok) {
        console.log(`[wait-for-foundry] Foundry is ready (${Math.round((Date.now() - start) / 1000)}s)`)
        return
      }
    } catch {
      // Not ready yet — swallow and retry
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
    process.stdout.write('.')
  }

  console.error(`\n[wait-for-foundry] Timed out after ${TIMEOUT_MS / 1000}s`)
  process.exit(1)
}

waitForFoundry()
