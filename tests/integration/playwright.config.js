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
import { existsSync, readdirSync } from 'fs'
import { homedir } from 'os'
import dotenv from 'dotenv'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load .env.test from tests/ root
dotenv.config({ path: join(__dirname, '../.env.test') })

const FOUNDRY_URL = process.env.FOUNDRY_URL || 'http://localhost:30000'

// GL backend: hardware (this machine's GPU) by default, software (SwiftShader,
// headless) when CFG3D_GL=software. Hardware needs the FULL Chromium (headed) —
// the headless shell can't reach the GPU. We point at the newest installed
// Playwright Chromium so no extra download is needed (CFG3D_CHROME overrides).
const SOFTWARE = process.env.CFG3D_GL === 'software'
function findFullChromium() {
  if (process.env.CFG3D_CHROME) return process.env.CFG3D_CHROME
  try {
    const base = join(homedir(), 'Library', 'Caches', 'ms-playwright')
    const dirs = readdirSync(base)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    for (const d of dirs) {
      for (const arch of ['chrome-mac-arm64', 'chrome-mac-x64']) {
        const p = join(base, d, arch, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
        if (existsSync(p)) return p
      }
    }
  } catch {
    /* fall through to Playwright's default resolution */
  }
  return undefined
}
const HW_CHROMIUM = SOFTWARE ? undefined : findFullChromium()

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
    // Hardware GL by default (this machine's GPU; runs headed via the full
    // Chromium). Set CFG3D_GL=software for headless SwiftShader (CI / no display).
    headless: SOFTWARE,
    launchOptions: {
      executablePath: HW_CHROMIUM,
      args: SOFTWARE
        ? ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader']
        : ['--ignore-gpu-blocklist', '--use-angle=metal'],
    },
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
      // `_*.spec.js` are headed human-review harnesses (setTimeout(0), hold the
      // browser open, no assertions) — they can't pass headless, so keep them out
      // of the automated run. Invoke one explicitly with --headed.
      testIgnore: ['_*.spec.js'],
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
