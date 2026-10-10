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

const qs = (params) => {
  const p = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== ''))
  return p.toString() ? `?${p}` : ''
}

export const api = {
  // ingestion
  upload: (form) => request('/api/upload', { method: 'POST', form }),
  ingestLink: (url, kind = 'inspo', notes = '') => request('/api/ingest/link', { method: 'POST', json: { url, kind, notes } }),
  jobs: () => request('/api/jobs'),
  retryJob: (id) => request(`/api/jobs/${id}/retry`, { method: 'POST' }),
  dismissJob: (id) => request(`/api/jobs/${id}`, { method: 'DELETE' }),
  // closet
  items: (params = {}) => request('/api/items' + qs(params)),
  updateItem: (id, patch) => request(`/api/items/${id}`, { method: 'PATCH', json: patch }),
  deleteItem: (id) => request(`/api/items/${id}`, { method: 'DELETE' }),
  tags: () => request('/api/tags'),
  // inspo
  inspo: (status = 'active') => request('/api/inspo' + qs({ status })),
  updateInspo: (id, patch) => request(`/api/inspo/${id}`, { method: 'PATCH', json: patch }),
  deleteInspo: (id) => request(`/api/inspo/${id}`, { method: 'DELETE' }),
  // profile / wear / overview
  profile: () => request('/api/profile'),
  saveProfile: (p) => request('/api/profile', { method: 'PUT', json: p }),
  wearLogs: (days = 60) => request('/api/wear-logs' + qs({ days })),
  logWear: (w) => request('/api/wear-logs', { method: 'POST', json: w }),
  overview: () => request('/api/overview'),
  // drops
  drops: () => request('/api/drops'),
  addDrop: (d) => request('/api/drops', { method: 'POST', json: d }),
  deleteDrop: (id) => request(`/api/drops/${id}`, { method: 'DELETE' }),
  syncDrops: () => request('/api/tracker/check', { method: 'POST', json: {} }),
}
