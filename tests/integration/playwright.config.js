/**
 * Playwright config for Foundry plugin integration tests.
 *
 * Runs against a local FoundryVTT container (port 30000).
 * Start the container first: npm run test:foundry:up (from package root)
 * Provision the Core fixtures (for the self-hosted/link specs) with:
 *   npm run test:foundry:provision
 *
 * Projects:
 *   setup        — logs into Foundry as GM, enables the module, injects settings
 *   integration  — the world-centric specs under ./specs (depends on setup)
 */

import { defineConfig, devices } from '@playwright/test'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import dotenv from 'dotenv'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load .env.test from tests/ root
dotenv.config({ path: join(__dirname, '../.env.test') })

const FOUNDRY_URL = process.env.FOUNDRY_URL || 'http://localhost:30000'

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? 'github' : 'list',

  use: {
    baseURL: FOUNDRY_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    // Above Foundry's 1366x768 minimum (Desktop Chrome's 1280x720 trips its
    // low-resolution gate, which can block sidebar/layout interactions).
    viewport: { width: 1920, height: 1080 },
  },

  projects: [
    {
      name: 'setup',
      testDir: './shared',
      testMatch: 'auth.setup.js',
    },
    {
      name: 'integration',
      testDir: './specs',
      testIgnore: 'overlay-3d.spec.js',
      dependencies: ['setup'],
      use: {
        storageState: join(__dirname, '../.auth/foundry.json'),
      },
    },
    {
      // Screenshot-review run for the 3D overlay — `npm run test:foundry:3d`.
      // Kept out of the `integration` project (testIgnore above) so the normal
      // suite doesn't pay for the camera-angle captures.
      name: '3d-screenshots',
      testDir: './specs',
      testMatch: 'overlay-3d.spec.js',
      dependencies: ['setup'],
      use: {
        storageState: join(__dirname, '../.auth/foundry.json'),
      },
    },
  ],

  globalSetup: './shared/globalSetup.js',
  globalTeardown: './shared/globalTeardown.js',

  outputDir: '../test-results/integration',
})
