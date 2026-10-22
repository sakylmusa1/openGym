// A profile that no longer fits in one request. Vercel Hobby refuses a body over 4.5 MB
// before the function runs, so a large push is gzipped when that lands under the limit,
// and otherwise split into ~2 MB parts. Docker accepts the single PUT either way; the
// part routes are there too, so one client speaks both.
const DIRECT = Math.floor(3.5 * 1024 * 1024)
const PART = 2 * 1024 * 1024

const bytesOf = text => new TextEncoder().encode(text)

async function gzip(bytes) {
  if (typeof CompressionStream !== 'function') return null
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function b64(bytes) {
  let out = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + step, bytes.length)))
  }
  return btoa(out)
}

export async function pushState(api, body) {
  const json = JSON.stringify(body)
  const raw = bytesOf(json)
  if (raw.byteLength <= DIRECT) return api('/api/data', { method: 'PUT', body: json })
  const packed = await gzip(raw)
  if (packed && packed.byteLength <= DIRECT) {
    return api('/api/data', {
      method: 'PUT',
      body: packed,
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }
    })
  }
  const payload = packed || raw
  const uploadId = (globalThis.crypto?.randomUUID && crypto.randomUUID()) || Math.random().toString(16).slice(2) + Date.now().toString(16)
  const total = Math.ceil(payload.byteLength / PART)
  for (let i = 0; i < total; i++) {
    const slice = payload.subarray(i * PART, (i + 1) * PART)
    await api('/api/data/part', {
      method: 'POST',
      body: JSON.stringify({ uploadId, index: i, total, gzip: !!packed, data: b64(slice) })
    })
  }
  return api('/api/data/commit', { method: 'POST', body: JSON.stringify({ uploadId }) })
}
