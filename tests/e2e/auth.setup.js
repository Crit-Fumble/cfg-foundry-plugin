/**
 * Playwright Authentication Setup
 * Handles Foundry VTT login and saves auth state for other tests
 */

import { test as setup, expect } from '@playwright/test'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const authFile = join(__dirname, '..', '.auth', 'user.json')

setup('authenticate', async ({ page }) => {
  // Go to Foundry root - this will show either setup, join, or game page
  await page.goto('/')

  // Wait for page to load
  await page.waitForLoadState('domcontentloaded')

  const pageTitle = await page.title()
  console.log('Initial page title:', pageTitle)

  // Check if we're on the join page
  const joinPage = await page.locator('form#join-game').count()
  if (joinPage > 0) {
    console.log('On join page, attempting to join as Gamemaster...')

    // Look for GM user option
    const gmSelect = page.locator('select[name="userid"]')
    if ((await gmSelect.count()) > 0) {
      // Find the GM option
      const options = await gmSelect.locator('option').all()
      for (const option of options) {
        const text = await option.textContent()
        if (text?.toLowerCase().includes('gamemaster') || text?.toLowerCase().includes('gm')) {
          const value = await option.getAttribute('value')
          await gmSelect.selectOption(value)
          console.log('Selected GM user:', text)
          break
        }
      }
    }

    // Check for password field
    const passwordField = page.locator('input[name="password"]')
    if (await passwordField.isVisible()) {
      // Try empty password first (common for local dev)
      await passwordField.fill('')
    }

    // Submit the join form
    const joinButton = page.locator('button[type="submit"], button:has-text("Join Game")')
    if ((await joinButton.count()) > 0) {
      await joinButton.click()
      console.log('Clicked join button')
    }

    // Wait for game to load
    try {
      await page.waitForSelector('#sidebar', { timeout: 30000 })
      console.log('Game loaded successfully')
    } catch (e) {
      console.log('Could not find #sidebar, checking current state...')
      const currentUrl = page.url()
      const currentTitle = await page.title()
      console.log('Current URL:', currentUrl)
      console.log('Current title:', currentTitle)
    }
  }

  // Check if we're already in game
  const sidebar = await page.locator('#sidebar').count()
  if (sidebar > 0) {
    console.log('Already authenticated and in game')
  }

  // Check for error page (no active world)
  const errorPage = await page.locator('body.error').count()
  if (errorPage > 0) {
    console.log('WARNING: No active world. Please start a world in Foundry VTT.')
    console.log('Tests will likely fail without an active world.')
  }

  // Save storage state
  await page.context().storageState({ path: authFile })
  console.log('Auth state saved to:', authFile)
})
