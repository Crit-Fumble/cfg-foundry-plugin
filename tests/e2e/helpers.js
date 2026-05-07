/**
 * Helper functions for Image Editor tests
 */

/**
 * Opens the Image Editor from the Scenes directory
 * @param {import('@playwright/test').Page} page
 */
export async function openImageEditor(page) {
  await page.click('#scenes')
  await page.waitForSelector('.cfg-image-editor-btn', { timeout: 5000 })
  await page.click('.cfg-image-editor-btn')
  await page.waitForSelector('.cfg-image-editor-container', { timeout: 5000 })
}

/**
 * Gets the Image Editor instance from the page
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<any>}
 */
export async function getImageEditor(page) {
  return await page.evaluate(() => {
    return Object.values(ui.windows).find((w) => w.constructor.name === 'ImageEditor')
  })
}

/**
 * Gets the canvas bounding box
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{x: number, y: number, width: number, height: number}>}
 */
export async function getCanvasBounds(page) {
  const canvas = await page.locator('#editor-canvas')
  return await canvas.boundingBox()
}

/**
 * Draws a line on the canvas
 * @param {import('@playwright/test').Page} page
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @param {number} steps - Number of steps for smooth line
 */
export async function drawLine(page, x1, y1, x2, y2, steps = 10) {
  await page.mouse.move(x1, y1)
  await page.mouse.down()
  await page.mouse.move(x2, y2, { steps })
  await page.mouse.up()
  await page.waitForTimeout(300)
}

/**
 * Gets the canvas data URL
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string>}
 */
export async function getCanvasData(page) {
  return await page.evaluate(() => {
    const editor = Object.values(ui.windows).find((w) => w.constructor.name === 'ImageEditor')
    return editor.drawingCanvas.toDataURL()
  })
}

/**
 * Selects a tool by ID
 * @param {import('@playwright/test').Page} page
 * @param {string} toolId - Tool ID without the '#tool-' prefix (e.g., 'brush', 'eraser')
 */
export async function selectTool(page, toolId) {
  await page.click(`#tool-${toolId}`)
  await page.waitForTimeout(200)
}

/**
 * Sets the brush color
 * @param {import('@playwright/test').Page} page
 * @param {string} color - Hex color (e.g., '#ff0000')
 */
export async function setBrushColor(page, color) {
  await page.fill('#brush-color', color)
  await page.waitForTimeout(100)
}

/**
 * Sets the brush size
 * @param {import('@playwright/test').Page} page
 * @param {number} size
 */
export async function setBrushSize(page, size) {
  await page.fill('#brush-size', String(size))
  await page.waitForTimeout(100)
}

/**
 * Verifies a tool is active
 * @param {import('@playwright/test').Page} page
 * @param {string} toolId - Tool ID without the '#tool-' prefix
 * @returns {Promise<boolean>}
 */
export async function isToolActive(page, toolId) {
  const activeClass = await page.getAttribute(`#tool-${toolId}`, 'class')
  return activeClass.includes('active')
}

/**
 * Toggles the grid
 * @param {import('@playwright/test').Page} page
 */
export async function toggleGrid(page) {
  await page.click('#toggle-grid')
  await page.waitForTimeout(200)
}

/**
 * Changes the scale
 * @param {import('@playwright/test').Page} page
 * @param {string} scaleId - Scale ID (e.g., 'arena', 'building')
 */
export async function changeScale(page, scaleId) {
  await page.selectOption('#scale-select', scaleId)
  await page.waitForTimeout(500)
}

/**
 * Performs undo operation
 * @param {import('@playwright/test').Page} page
 */
export async function undo(page) {
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(500)
}

/**
 * Performs redo operation
 * @param {import('@playwright/test').Page} page
 */
export async function redo(page) {
  await page.keyboard.press('Control+Shift+z')
  await page.waitForTimeout(500)
}

/**
 * Gets the number of Fabric objects on canvas
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<number>}
 */
export async function getFabricObjectCount(page) {
  return await page.evaluate(() => {
    const editor = Object.values(ui.windows).find((w) => w.constructor.name === 'ImageEditor')
    return editor.fabricCanvas.getObjects().length
  })
}

/**
 * Waits for Foundry VTT to be ready
 * @param {import('@playwright/test').Page} page
 */
export async function waitForFoundry(page) {
  await page.waitForSelector('#sidebar', { timeout: 10000 })
  await page.waitForFunction(() => game && game.ready, { timeout: 10000 })
}

/**
 * Ensures user is logged in as GM
 * @param {import('@playwright/test').Page} page
 * @throws {Error} if user is not GM
 */
export async function ensureGM(page) {
  const userRole = await page.evaluate(() => game.user.role)
  if (userRole < 4) {
    throw new Error('Tests must be run as GM (Gamemaster)')
  }
}

/**
 * Takes a screenshot with a custom name
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
export async function screenshot(page, name) {
  await page.screenshot({ path: `test-results/screenshots/${name}.png`, fullPage: true })
}
