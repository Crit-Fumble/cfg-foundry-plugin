/**
 * Playwright config for Foundry plugin integration tests.
 *
 * Runs against a local FoundryVTT container (port 30000).
 * Start the container first: npm run test:foundry:up (from package root)
 *
 * Two test projects:
 *   core-hosted  — API client uses session cookies (no API key set)
 *   self-hosted  — API client uses cfk_ Bearer token (CORE_TEST_API_KEY required)
 *
 * Both depend on the shared auth setup project, which logs into Foundry as GM
 * and injects module settings into the running world.
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
  },

  projects: [
    {
      name: 'setup',
      testDir: './shared',
      testMatch: 'auth.setup.js',
    },
    {
      name: 'core-hosted',
      testDir: './core-hosted',
      dependencies: ['setup'],
      use: {
        storageState: join(__dirname, '../.auth/foundry.json'),
      },
    },
    {
      name: 'self-hosted',
      testDir: './self-hosted',
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
