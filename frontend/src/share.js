import { api } from './api'

const SHARE_CACHE = 'shared-inbox'

export function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  }
}

// Social apps share "caption text https://link" - pull the first link out.
export function extractUrl(text) {
  const m = (text || '').match(/https?:\/\/[^\s"'<>]+/)
  return m ? m[0].replace(/[).,!?]+$/, '') : null
}

/** If opened from the share sheet, return what was shared: { link, files } (null otherwise). */
export async function readShare() {
  const params = new URLSearchParams(location.search)
  if (!params.has('shared')) return null
  params.delete('shared')
  history.replaceState(null, '', location.pathname + (params.toString() ? `?${params}` : ''))
  if (!('caches' in window)) return null
  const cache = await caches.open(SHARE_CACHE)
  const metaRes = await cache.match('/shared/meta')
  if (!metaRes) return null
  const { text, count } = await metaRes.json()
  const files = []
  for (let i = 0; i < count; i++) {
    const res = await cache.match(`/shared/file-${i}`)
    if (!res) continue
    const blob = await res.blob()
    const name = decodeURIComponent(res.headers.get('X-File-Name') || `shared-${i}`)
    files.push(new File([blob], name, { type: blob.type }))
  }
  await caches.delete(SHARE_CACHE)
  return { link: extractUrl(text), files }
}

/** Queue shared content for analysis as closet pieces or inspo. Returns how many were queued. */
export async function submitShare({ link, files }, kind) {
  let n = 0
  if (!files.length && link) {
    await api.ingestLink(link, kind); n++
  }
  for (const f of files) {
    const form = new FormData()
    form.append('file', f)
    form.append('kind', kind)
    if (link) form.append('source_url', link)
    await api.upload(form); n++
  }
  return n
}
