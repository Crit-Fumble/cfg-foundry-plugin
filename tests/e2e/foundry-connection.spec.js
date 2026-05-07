import { test, expect } from '@playwright/test'

/**
 * Basic Foundry VTT Connection Tests
 * Run these first to verify Foundry is accessible
 */

test.describe('Foundry VTT Connection', () => {
  test('should access Foundry VTT root', async ({ page }) => {
    await page.goto('/')

    // Should get some Foundry response (setup, join, or game page)
    const title = await page.title()
    console.log('Page title:', title)

    // Title should either contain "Foundry" or be a world name
    expect(title.length).toBeGreaterThan(0)
  })

  test('should access game or join page', async ({ page }) => {
    await page.goto('/game')

    // Wait for game to load (we should already be authenticated)
    await page.waitForSelector('#sidebar', { timeout: 15000 })

    const hasGame = await page.locator('#sidebar').isVisible()
    console.log('Has game loaded:', hasGame)

    expect(hasGame).toBeTruthy()
  })

  test('should verify game is ready', async ({ page }) => {
    await page.goto('/game')
    await page.waitForSelector('#sidebar', { timeout: 15000 })

    // Wait for game to be ready
    await page.waitForFunction(() => window.game && window.game.ready, { timeout: 20000 })

    const isReady = await page.evaluate(() => game.ready)
    console.log('Game ready:', isReady)

    expect(isReady).toBeTruthy()
  })

  test('should verify GM access', async ({ page }) => {
    await page.goto('/game')
    await page.waitForSelector('#sidebar', { timeout: 15000 })
    await page.waitForFunction(() => window.game && window.game.ready, { timeout: 20000 })

    // Check user role
    const userRole = await page.evaluate(() => game.user.role)
    const userName = await page.evaluate(() => game.user.name)

    console.log('Logged in as:', userName)
    console.log('User role:', userRole, '(4 = GM)')

    expect(userRole).toBe(4) // CONST.USER_ROLES.GAMEMASTER = 4
  })
})
