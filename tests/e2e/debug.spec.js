import { test } from '@playwright/test'

/**
 * Debug test to see what's actually on the page
 */

test('debug - see what page loads', async ({ page }) => {
  console.log('Navigating to http://localhost:30000/game')

  await page.goto('/game', { waitUntil: 'domcontentloaded' })

  // Wait a bit for page to load
  await page.waitForTimeout(5000)

  // Get page title
  const title = await page.title()
  console.log('Page title:', title)

  // Get page URL
  const url = page.url()
  console.log('Current URL:', url)

  // Check for various selectors
  const selectors = ['#sidebar', '.application', 'body', '#ui-left', '#ui-right', '#navigation', '.vtt', '#board']

  for (const selector of selectors) {
    const exists = await page.locator(selector).count()
    console.log(`${selector}: ${exists > 0 ? 'FOUND' : 'NOT FOUND'} (${exists})`)
  }

  // Get page HTML (first 2000 chars)
  const html = await page.content()
  console.log('Page HTML (first 2000 chars):', html.substring(0, 2000))

  // Take a screenshot
  await page.screenshot({ path: 'debug-page.png', fullPage: true })
  console.log('Screenshot saved to debug-page.png')

  // Wait so you can see the browser
  await page.waitForTimeout(5000)
})
