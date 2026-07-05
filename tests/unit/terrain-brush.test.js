/**
 * applyTerrainBrush — pure sculpt math, tested without THREE/Foundry.
 */
import { applyTerrainBrush } from '../../scripts/services/overlay3d/terrain-brush.js'

// a 5x5 flat field at height 0
const flat = () => new Array(25).fill(0)
const at = (h, i, j) => h[j * 5 + i]

describe('applyTerrainBrush', () => {
  it('raise: centre rises most, falls off with distance, outside the radius is untouched', () => {
    const h = applyTerrainBrush(flat(), 5, 5, { mode: 'raise', u: 0.5, v: 0.5, radius: 0.4, strength: 10 })
    expect(at(h, 2, 2)).toBeCloseTo(10) // centre = full strength
    expect(at(h, 2, 1)).toBeGreaterThan(0) // one cell away = partial
    expect(at(h, 2, 1)).toBeLessThan(10)
    expect(at(h, 0, 0)).toBe(0) // corner, outside a 0.4·5=2-cell radius from centre (dist √8≈2.83)
    expect(h).not.toBe(flat()) // returns a new array
  })

  it('lower: centre drops most (mirror of raise)', () => {
    const h = applyTerrainBrush(flat(), 5, 5, { mode: 'lower', u: 0.5, v: 0.5, radius: 0.4, strength: 8 })
    expect(at(h, 2, 2)).toBeCloseTo(-8)
  })

  it('level: cells blend toward the target height; outside the radius stays put', () => {
    const src = flat().map(() => 5) // all at 5
    const h = applyTerrainBrush(src, 5, 5, { mode: 'level', u: 0.5, v: 0.5, radius: 0.3, strength: 1, level: 20 })
    expect(at(h, 2, 2)).toBeCloseTo(20) // centre (falloff 1, strength 1) snaps to target
    expect(at(h, 2, 1)).toBeGreaterThan(5) // one cell away blends partway
    expect(at(h, 2, 1)).toBeLessThan(20)
    expect(at(h, 2, 0)).toBe(5) // 2 cells away > 0.3·5=1.5 radius → untouched
  })

  it('smooth: a spike is pulled toward its neighbours', () => {
    const src = flat()
    src[2 * 5 + 2] = 100 // a spike at the centre
    const h = applyTerrainBrush(src, 5, 5, { mode: 'smooth', u: 0.5, v: 0.5, radius: 0.6, strength: 1 })
    expect(at(h, 2, 2)).toBeLessThan(100) // pulled down toward the 0 neighbours
    expect(at(h, 2, 2)).toBeGreaterThan(0)
  })

  it('guards: degenerate inputs return an untouched copy', () => {
    expect(applyTerrainBrush([1, 2, 3], 3, 3, { mode: 'raise', u: 0.5, v: 0.5 })).toEqual([1, 2, 3]) // too few cells
    const f = flat()
    expect(applyTerrainBrush(f, 5, 5, { mode: 'raise', u: NaN, v: 0.5 })).toEqual(f)
  })
})
