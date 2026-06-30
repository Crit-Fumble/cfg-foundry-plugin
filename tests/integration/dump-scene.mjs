import { chromium } from '@playwright/test'
import { ensureInGame } from './shared/foundry-login.mjs'

const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, baseURL: 'http://localhost:30000' })
const page = await ctx.newPage()
await ensureInGame(page)
await page.waitForFunction(() => globalThis.canvas?.ready === true, { timeout: 60_000 })

const data = await page.evaluate(() => {
  const num = (v) => (v == null ? v : typeof v === 'object' && v.toNumber ? v.toNumber() : Number(v))
  const toHex = (v) => {
    const n = num(v)
    return Number.isFinite(n) && n >= 0 ? '#' + n.toString(16).padStart(6, '0') : v
  }
  const s = canvas.scene
  const env = s.environment || {}
  const out = {
    grid: { type: s.grid?.type, size: s.grid?.size, distance: s.grid?.distance, color: s.grid?.color, alpha: s.grid?.alpha },
    sceneEnvironment: {
      darknessLevel: env.darknessLevel,
      cycle: env.cycle,
      globalLight: env.globalLight
        ? { enabled: env.globalLight.enabled, color: env.globalLight.color, alpha: env.globalLight.alpha, bright: env.globalLight.bright, luminosity: env.globalLight.luminosity }
        : null,
      base: env.base,
      dark: env.dark,
    },
    canvasEnvironment: {
      darknessLevel: canvas.environment?.darknessLevel,
      colorKeys: canvas.environment?.colors ? Object.keys(canvas.environment.colors) : null,
      colors: {},
    },
    ambientLights: (canvas.lighting?.placeables || []).map((l) => {
      const d = l.document
      return { x: d.x, y: d.y, elevation: d.elevation, walls: d.walls, config: { color: d.config?.color, dim: d.config?.dim, bright: d.config?.bright, alpha: d.config?.alpha, angle: d.config?.angle } }
    }),
  }
  try {
    const c = canvas.environment?.colors || {}
    for (const k of Object.keys(c)) out.canvasEnvironment.colors[k] = toHex(c[k])
  } catch (e) {
    out.canvasEnvironment.colors = 'err:' + e.message
  }
  return out
})
console.log(JSON.stringify(data, null, 2))
await browser.close()
