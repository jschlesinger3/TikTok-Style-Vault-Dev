const BASE = import.meta.env.VITE_API_URL || ''
const KEY = import.meta.env.VITE_API_KEY || ''

async function request(path, { json, form, ...opts } = {}) {
  const headers = { ...(KEY && { 'X-API-Key': KEY }) }
  let body
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json) }
  if (form) body = form
  const res = await fetch(BASE + path, { ...opts, headers, body })
  if (!res.ok) {
    let detail = res.statusText
    try { const d = (await res.json()).detail; detail = typeof d === 'string' ? d : JSON.stringify(d) } catch {}
    throw new Error(detail)
  }
  return res.status === 204 ? null : res.json()
}

export const api = {
  outfits: (tag) => request('/api/outfits' + (tag ? `?tag=${encodeURIComponent(tag)}` : '')),
  upload: (form) => request('/api/upload', { method: 'POST', form }),
  updateOutfit: (id, patch) => request(`/api/outfits/${id}`, { method: 'PATCH', json: patch }),
  deleteOutfit: (id) => request(`/api/outfits/${id}`, { method: 'DELETE' }),
  ingestLink: (url, aesthetic_tags = []) => request('/api/ingest/link', { method: 'POST', json: { url, aesthetic_tags } }),
  reanalyze: (id) => request(`/api/outfits/${id}/reanalyze`, { method: 'POST' }),
  catalog: (category) => request('/api/catalog' + (category ? `?category=${encodeURIComponent(category)}` : '')),
  tags: () => request('/api/tags'),
  drops: () => request('/api/drops'),
  addDrop: (d) => request('/api/drops', { method: 'POST', json: d }),
  deleteDrop: (id) => request(`/api/drops/${id}`, { method: 'DELETE' }),
  syncDrops: () => request('/api/tracker/check', { method: 'POST', json: {} }),
}
