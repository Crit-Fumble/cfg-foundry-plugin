/**
 * Jest configuration for crit-fumble-core module
 * Uses ES modules with experimental VM modules support
 *
 * NOTE: E2E tests use Playwright and should be run with:
 *   npm run test:e2e
 *
 * Jest unit tests should be run with:
 *   npm test
 */
export default {
  testEnvironment: 'node',
  transform: {},
  moduleFileExtensions: ['js', 'mjs'],

  // Only match .test.js files, not .spec.js (which are Playwright e2e tests)
  // testMatch with cross-platform glob pattern
  testMatch: ['**/*.test.js'],

  // Setup runs before each test file to set up globals
  setupFilesAfterEnv: ['<rootDir>/setup.js'],

  // Exclude e2e folder and spec files
  // Uses cross-platform regex patterns that work on both Unix and Windows
  testPathIgnorePatterns: ['[/\\\\]node_modules[/\\\\]', '[/\\\\]e2e[/\\\\]', '\\.spec\\.js$'],

  // Don't transform our source files (they're ES modules)
  transformIgnorePatterns: [],

  // Coverage settings
  collectCoverageFrom: ['../scripts/**/*.js', '!../scripts/**/index.js'],
  coverageDirectory: './coverage',
  coverageReporters: ['text', 'lcov', 'html'],
}
