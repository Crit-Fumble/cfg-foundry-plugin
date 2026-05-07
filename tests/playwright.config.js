import { defineConfig, devices } from '@playwright/test'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  testDir: join(__dirname, 'e2e'),
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // Run tests sequentially for Foundry
  reporter: [['html', { outputFolder: join(__dirname, 'playwright-report') }]],
  outputDir: join(__dirname, 'test-results'),

  timeout: 60000, // 60 seconds per test
  expect: {
    timeout: 10000, // 10 seconds for assertions
  },

  use: {
    baseURL: 'http://localhost:30000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15000, // 15 seconds for actions
    navigationTimeout: 30000, // 30 seconds for navigation
  },

  projects: [
    // Setup project - runs first to authenticate
    {
      name: 'setup',
      testMatch: /auth\.setup\.js/,
    },
    // Main tests - depend on setup
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 }, // Full HD for better testing
        storageState: join(__dirname, '.auth', 'user.json'),
      },
      dependencies: ['setup'],
    },
  ],

  webServer: {
    command: 'echo "Foundry VTT should be running on port 30000"',
    url: 'http://localhost:30000',
    reuseExistingServer: true,
    timeout: 5000,
  },
})
