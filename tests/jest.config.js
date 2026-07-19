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

  // Jest hangs after the suite passes — something (a timer or open handle in
  // the service tests) keeps the event loop alive, and it prints "Jest did not
  // exit one second after the test run has completed."
  //
  // That is not cosmetic here: .husky/pre-push runs `npm test`, so every push
  // blocked on the hung runner until it was killed by hand. forceExit is the
  // same safety net cfg-core-server uses. Chasing the leak itself needs
  // `--detectOpenHandles`, which is a separate job.
  forceExit: true,

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
