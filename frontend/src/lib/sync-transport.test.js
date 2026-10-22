import { describe, it, expect, vi } from 'vitest'
import { pushState } from './sync-transport.js'

describe('pushState', () => {
  it('sends a small profile as one PUT of the JSON text', async () => {
    const api = vi.fn(async () => ({ ok: true, rev: 1 }))
    const body = { state: { workouts: [], routines: [] }, stamped: true, baseRev: 0 }
    await pushState(api, body)
    expect(api).toHaveBeenCalledTimes(1)
    expect(api.mock.calls[0][0]).toBe('/api/data')
    expect(api.mock.calls[0][1].method).toBe('PUT')
    expect(JSON.parse(api.mock.calls[0][1].body)).toEqual(body)
  })

  it('gzips a profile that would not fit in one function body', async () => {
    const api = vi.fn(async () => ({ ok: true, rev: 2 }))
    const body = { state: { workouts: [], routines: [], note: 'x'.repeat(4 * 1024 * 1024) }, stamped: true }
    await pushState(api, body)
    const paths = api.mock.calls.map(c => c[0])
    if (paths[0] === '/api/data') {
      expect(api.mock.calls[0][1].headers['Content-Encoding']).toBe('gzip')
      expect(api.mock.calls[0][1].body.byteLength).toBeLessThan(3.5 * 1024 * 1024)
    } else {
      expect(paths.filter(p => p === '/api/data/part').length).toBeGreaterThan(0)
      expect(paths.at(-1)).toBe('/api/data/commit')
    }
  })
})
