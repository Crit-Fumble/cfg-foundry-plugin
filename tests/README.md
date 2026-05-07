# CFG Core Module - Integration Tests

Playwright-based integration tests for the CFG Core module's Image Editor functionality.

## Prerequisites

1. **Foundry VTT Running**: The tests expect Foundry VTT to be running on `http://localhost:30000`
   - Docker: `docker run -d -p 30000:30000 your-foundry-image`
   - Or: `node main.js --port=30000 --dataPath=./vtt_data`

2. **World Launched**: A world must be created and actively running
   - Go to http://localhost:30000
   - Launch your world
   - Make sure you can access the game

3. **Module Installed**: The `crit-fumble-core` module must be installed and enabled
   - In Foundry, go to Add-on Modules
   - Enable "Crit-Fumble Core"
   - Return to the world

4. **Logged in as GM**: You must be logged in as a Gamemaster
   - The tests use your existing session
   - Make sure you're logged in as GM before running tests

5. **Active Scene**: At least one scene should be created
   - Go to Scenes tab
   - Create a scene (can be blank)

## Quick Start

```bash
# 1. Make sure Foundry VTT is running on port 30000 with Docker
# Your world should be launched and you should be logged in as GM

# 2. Install test dependencies
cd tests
npm install
npx playwright install chromium

# 3. Run connection tests first to verify setup
npm run test:connection

# 4. If connection tests pass, run all Image Editor tests
npm run test:image-editor
```

## Running Tests

### Run all tests:

```bash
npm test
```

### Run tests with UI (recommended for development):

```bash
npm run test:ui
```

### Run tests in headed mode (see browser):

```bash
npm run test:headed
```

### Run only Image Editor tests:

```bash
npm run test:image-editor
```

### Debug a specific test:

```bash
npm run test:debug
```

### View test report:

```bash
npm run report
```

## Test Coverage

### Image Editor Tests (`e2e/image-editor.spec.js`)

#### Basic Functionality

- ✅ Opens Image Editor from Scenes directory
- ✅ All drawing tools are available
- ✅ Switches between drawing tools
- ✅ Opens at full screen by default
- ✅ Has transparent background by default

#### Drawing Tools

- ✅ Brush tool draws pixels
- ✅ Eraser tool erases pixels
- ✅ Line tool draws lines
- ✅ Rectangle tool draws rectangles
- ✅ Circle tool draws circles

#### Controls

- ✅ Changes brush color
- ✅ Changes brush size
- ✅ Toggles grid visibility
- ✅ Changes scale and updates grid

#### Keyboard Shortcuts

- ✅ `B` - Brush
- ✅ `E` - Eraser
- ✅ `L` - Line
- ✅ `R` - Rectangle
- ✅ `C` - Circle
- ✅ `Ctrl+Z` - Undo
- ✅ `Ctrl+Shift+Z` - Redo

#### Save/Export

- ✅ Exports image as PNG download

## Known Issues to Test

Based on your feedback that "several tools do not work correctly", the tests will help identify:

1. **Drawing Tool Issues**: Tests verify each tool actually modifies the canvas
2. **Shape Tool Issues**: Tests verify shapes are created on canvas
3. **Undo/Redo Issues**: Tests verify history management works
4. **Grid Overlay Issues**: Tests verify grid can be toggled
5. **Keyboard Shortcut Issues**: Tests verify all shortcuts work

## Test Output

Tests will generate:

- Screenshots on failure
- Videos on failure
- HTML report with detailed results
- Trace files for debugging

## Debugging Failed Tests

1. **Run with UI**: `npm run test:ui` - Interactive mode with time-travel debugging
2. **Run headed**: `npm run test:headed` - See the browser as tests run
3. **Debug mode**: `npm run test:debug` - Step through tests line by line
4. **Check screenshots**: Failed tests save screenshots in `test-results/`
5. **View trace**: Open trace files in Playwright Trace Viewer

## CI/CD Integration

These tests can be integrated into CI/CD pipelines:

```yaml
# Example GitHub Actions workflow
- name: Run Foundry VTT
  run: docker run -d -p 30000:30000 foundry-vtt

- name: Install test dependencies
  run: |
    cd tests
    npm ci
    npx playwright install --with-deps chromium

- name: Run integration tests
  run: cd tests && npm test

- name: Upload test results
  if: always()
  uses: actions/upload-artifact@v3
  with:
    name: playwright-report
    path: tests/playwright-report/
```

## Contributing

When adding new features to the Image Editor:

1. Add corresponding tests to `e2e/image-editor.spec.js`
2. Run tests locally before committing
3. Ensure all tests pass in CI

## Troubleshooting

### "Tests must be run as GM"

- Log in to Foundry VTT as a Gamemaster before running tests

### "Timeout waiting for selector"

- Ensure Foundry VTT is running on port 30000
- Check that the crit-fumble-core module is enabled
- Verify you have an active scene

### "Cannot find ImageEditor"

- The Image Editor class must be globally accessible
- Check browser console for module loading errors

### Tests failing randomly

- Increase timeout values in `playwright.config.js`
- Run tests with `--headed` flag to observe behavior
- Check for race conditions in drawing operations
