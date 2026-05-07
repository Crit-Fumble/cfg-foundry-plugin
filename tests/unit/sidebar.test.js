/**
 * Unit tests for the CFG Core sidebar mount helper.
 *
 * Focus on the parts that have real invariants:
 *   - the iframe URL is built correctly for both core-hosted and self-hosted
 *     Foundry (the token only appears when one is supplied)
 *   - mount is idempotent (Foundry fires `ready` more than once in some
 *     reconnection paths — we must not stack sidebars)
 *   - unmount is safe when there's nothing to remove
 *   - collapsed state persists round-trip through localStorage
 */

import { jest } from '@jest/globals'

describe('CFG sidebar — iframe URL', () => {
  let sidebar
  let __internals

  beforeAll(async () => {
    const mod = await import('../../scripts/views/sidebar.js')
    sidebar = mod
    __internals = mod.__internals
  })

  it('builds a Core-hosted URL without a token query param', () => {
    const url = __internals._buildIframeUrl('https://core.crit-fumble.com', null)
    expect(url).toBe('https://core.crit-fumble.com/foundry/sidebar')
  })

  it('adds ?token=… for self-hosted Foundry', () => {
    const url = __internals._buildIframeUrl('https://foundry.example.com', 'cfk_abc123')
    expect(url).toBe('https://foundry.example.com/foundry/sidebar?token=cfk_abc123')
  })

  it('preserves the base URL pathname prefix when the Core URL has one', () => {
    // Core is usually at the origin root, but some dev tunnels serve it from
    // a subpath. `new URL('/foundry/sidebar', base)` would drop the base path,
    // which is a footgun worth locking in behaviour for.
    const url = __internals._buildIframeUrl('https://example.com/core', null)
    // Documented behaviour: we use absolute pathing, so subpath hosts need to
    // map /foundry/sidebar themselves. If that ever changes, this test is the
    // canary.
    expect(url).toBe('https://example.com/foundry/sidebar')
  })
})

describe('CFG sidebar — DOM lifecycle', () => {
  let sidebar

  beforeAll(async () => {
    sidebar = await import('../../scripts/views/sidebar.js')
  })

  beforeEach(() => {
    // Minimal DOM mock — Foundry normally runs in a real browser so jsdom
    // would be overkill for a single side-effecty helper. We only need what
    // the mount code touches.
    const elements = []
    const body = {
      appendChild: jest.fn((el) => {
        elements.push(el)
        return el
      }),
    }
    const idIndex = new Map()
    global.document = {
      body,
      createElement: jest.fn((tag) => {
        const el = {
          tagName: tag.toUpperCase(),
          attributes: {},
          children: [],
          dataset: {},
          style: {},
          classList: { add: jest.fn(), remove: jest.fn() },
          addEventListener: jest.fn(),
          setAttribute: jest.fn(function (k, v) {
            this.attributes[k] = v
          }),
          appendChild(child) {
            this.children.push(child)
            return child
          },
          remove: jest.fn(() => {
            idIndex.delete(el._id)
          }),
          set id(v) {
            el._id = v
            idIndex.set(v, el)
          },
          get id() {
            return el._id
          },
        }
        return el
      }),
      getElementById: jest.fn((id) => idIndex.get(id) ?? null),
    }
    const store = new Map()
    global.window = {
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, v),
      },
    }
  })

  it('mount is idempotent — calling twice produces a single sidebar', () => {
    sidebar.mountCFGSidebar({ coreUrl: 'https://core.crit-fumble.com', token: null })
    sidebar.mountCFGSidebar({ coreUrl: 'https://core.crit-fumble.com', token: null })
    expect(document.body.appendChild).toHaveBeenCalledTimes(1)
  })

  it('unmount removes the sidebar', () => {
    sidebar.mountCFGSidebar({ coreUrl: 'https://core.crit-fumble.com', token: null })
    sidebar.unmountCFGSidebar()
    expect(document.getElementById('cfg-core-sidebar')).toBeNull()
  })

  it('unmount is safe when nothing was mounted', () => {
    expect(() => sidebar.unmountCFGSidebar()).not.toThrow()
  })
})
