# Troubleshooting Guide

## Expected Test Failures

Based on your feedback that "several tools do not work correctly", here are the tests that will likely fail and what they reveal:

### 1. Drawing Tools Not Working

**Test**: `should draw with brush tool`

**Symptoms**:

- Canvas data doesn't change after drawing
- Drawing events not triggering

**Possible Causes**:

- Mouse event listeners not attached properly
- `setupPixelDrawing()` not being called
- Drawing context issues
- Canvas not being updated after drawing

**Debug Steps**:

```javascript
// Check if drawing canvas exists
const editor = Object.values(ui.windows).find((w) => w instanceof ImageEditor)
console.log('Drawing canvas:', editor.drawingCanvas)
console.log('Drawing context:', editor.drawingContext)

// Check if mouse events are attached
editor.fabricCanvas.on('mouse:down', (e) => console.log('Mouse down', e))
```

### 2. Eraser Not Working

**Test**: `should erase with eraser tool`

**Symptoms**:

- Eraser draws instead of erasing
- Canvas not being cleared

**Possible Causes**:

- `globalCompositeOperation` not set to 'destination-out'
- Eraser color not transparent
- Drawing with wrong context

**Fix**: Check `drawPixel()` and `drawPixelLine()` methods:

```javascript
if (this.currentTool === 'eraser') {
  ctx.globalCompositeOperation = 'destination-out'
} else {
  ctx.globalCompositeOperation = 'source-over'
}
```

### 3. Shape Tools Not Drawing

**Test**: `should draw shapes with shape tools`

**Symptoms**:

- No shapes appear on canvas
- Mouse events not firing for shapes

**Possible Causes**:

- `setupShapeTool()` removing all mouse listeners including pixel drawing
- Shape tool mouse handlers conflicting with pixel drawing handlers
- Shapes being added but not visible

**Fix**: Shape tools need to properly handle mouse events separately from pixel drawing.

### 4. Undo/Redo Not Working

**Test**: `should undo and redo drawings`

**Symptoms**:

- Ctrl+Z doesn't undo
- History not being saved
- Canvas not restoring to previous state

**Possible Causes**:

- `saveState()` not being called after drawing
- History state not including pixel canvas data
- `loadState()` not properly restoring canvas

**Fix**: Ensure `saveState()` is called in:

- `setupPixelDrawing()` mouse:up event
- `setupShapeTool()` mouse:up event
- After any drawing operation

### 5. Grid Not Visible

**Test**: `should toggle grid visibility`

**Symptoms**:

- Grid doesn't show up
- Grid overlay is empty

**Possible Causes**:

- `drawGrid()` not being called on initialization
- Grid objects not being added to overlay
- Grid overlay not on top layer

**Fix**: Check grid initialization:

```javascript
// After creating gridOverlay
this.drawGrid() // Make sure this is called

// Check grid objects
console.log('Grid objects:', this.gridOverlay._objects)
```

### 6. Keyboard Shortcuts Not Working

**Test**: `should use keyboard shortcuts for tools`

**Symptoms**:

- Pressing B/E/L/R/C doesn't switch tools
- Ctrl+Z doesn't undo

**Possible Causes**:

- Event listener not attached to correct element
- Events being captured by Foundry
- Input elements stealing focus

**Fix**: Check `handleKeyboard()`:

```javascript
// Make sure this is attached to the right element
html.addEventListener('keydown', (e) => this.handleKeyboard(e))

// And not filtering out tool shortcuts
if (event.target.tagName === 'INPUT') {
  return // This might be too aggressive
}
```

### 7. Full Screen Not Working

**Test**: `should open at full screen`

**Symptoms**:

- Window opens small
- Window dimensions not 100%

**Possible Causes**:

- ApplicationV2 not respecting '100%' values
- Position needs numeric values

**Fix**: Try setting actual pixel values:

```javascript
position: {
  width: window.innerWidth,
  height: window.innerHeight
}
```

### 8. Transparent Background Issues

**Test**: `should have transparent background by default`

**Symptoms**:

- Background is gray/black instead of transparent
- Checkered pattern not showing transparency

**Possible Causes**:

- Fabric canvas backgroundColor not set correctly
- Drawing canvas background not transparent

**Fix**: Verify both canvases:

```javascript
// Fabric canvas
this.fabricCanvas = new fabric.Canvas(canvas, {
  backgroundColor: 'rgba(0, 0, 0, 0)', // Must be rgba
})

// Drawing canvas should default to transparent
// No fillRect or background needed
```

## Running Specific Test for Debugging

To debug a specific failing test:

```bash
# Run one test with debug mode
npx playwright test -g "should draw with brush tool" --debug

# Run one test headed (see browser)
npx playwright test -g "should draw with brush tool" --headed

# Run with console logs
DEBUG=pw:api npx playwright test -g "should draw with brush tool"
```

## Common Fixes

### Fix: Drawing Not Working

The issue is likely in `setupPixelDrawing()`. The mouse event handlers might be getting removed by `setupShapeTool()`.

**Solution**: Don't remove all mouse listeners, only remove shape-specific ones.

### Fix: Multiple Tools Interfering

Shape tools and pixel tools are conflicting because they both use mouse events on the same canvas.

**Solution**: Use a state machine to handle tool modes properly:

```javascript
setupPixelDrawing() {
  this.fabricCanvas.on('mouse:down', (options) => {
    // Check current tool and route accordingly
    if (this.currentTool === 'line' || this.currentTool === 'rectangle' ||
        this.currentTool === 'circle' || this.currentTool === 'fill') {
      return; // Let shape tool handle it
    }
    // Handle pixel drawing
  });
}
```

### Fix: History Not Saving Pixels

The history system needs to save both pixel data and Fabric data.

**Solution**: Already implemented in `saveState()`, but make sure it's being called:

```javascript
// After any drawing operation
this.saveState()
```

## Next Steps

1. **Run the tests**: `npm test`
2. **Identify failures**: Note which tests fail
3. **Use helpers**: Import helper functions for debugging
4. **Check console**: Browser console often has clues
5. **Step through**: Use `--debug` to step through failing tests
6. **Fix incrementally**: Fix one tool at a time
7. **Re-run tests**: Verify fixes work

## Getting Help

If tests are failing and you can't figure out why:

1. Run with `--debug` flag
2. Check the HTML report: `npm run report`
3. Look at screenshots in `test-results/`
4. Check trace files for detailed timeline
5. Add console.log statements to the Image Editor code
6. Use Playwright Inspector to step through the test
