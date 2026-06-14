/**
 * Activity heartbeat (cfs#109) — single-reporter election + active-user
 * count reporting to Core. The heartbeat is what gives server-side
 * idle-shutdown automation a real signal.
 */

import { jest } from '@jest/globals'
import { ActivityHeartbeat } from '../../scripts/services/activity-heartbeat.js'

function api() {
  return { post: jest.fn(async () => ({ ok: true })) }
}

describe('ActivityHeartbeat', () => {
  it('reports the active count when this client is the elected (smallest-id) reporter', async () => {
    game.users = [
      { id: 'a', active: true },
      { id: 'b', active: true },
      { id: 'c', active: false },
    ]
    game.user = { id: 'a' }
    const a = api()

    await new ActivityHeartbeat(a, 'inst-1')._tick()

    expect(a.post).toHaveBeenCalledWith('/api/v1/installations/inst-1/activity', {
      activeUserCount: 2,
      source: 'foundry-plugin',
    })
  })

  it('stays quiet when another active client is the elected reporter', async () => {
    game.users = [
      { id: 'a', active: true },
      { id: 'b', active: true },
    ]
    game.user = { id: 'b' } // not the smallest id
    const a = api()

    await new ActivityHeartbeat(a, 'inst-1')._tick()

    expect(a.post).not.toHaveBeenCalled()
  })

  it('counts only active users', async () => {
    game.users = [
      { id: 'a', active: true },
      { id: 'b', active: false },
      { id: 'c', active: true },
    ]
    game.user = { id: 'a' }
    const a = api()

    await new ActivityHeartbeat(a, 'inst-1')._tick()

    expect(a.post.mock.calls[0][1].activeUserCount).toBe(2)
  })

  it('is non-fatal when the report fails', async () => {
    game.users = [{ id: 'a', active: true }]
    game.user = { id: 'a' }
    const a = { post: jest.fn(async () => { throw new Error('network') }) }

    await expect(new ActivityHeartbeat(a, 'inst-1')._tick()).resolves.toBeUndefined()
  })

  it('does not start without an installationId', () => {
    const a = api()
    const hb = new ActivityHeartbeat(a, null)
    hb.start()
    expect(a.post).not.toHaveBeenCalled()
    hb.stop()
  })
})
