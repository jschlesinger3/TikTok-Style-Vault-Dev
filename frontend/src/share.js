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

/** If we were opened via the share sheet, send everything to the vault. Returns #items added. */
export async function consumeShare(notify) {
  const params = new URLSearchParams(location.search)
  if (!params.has('shared')) return 0
  history.replaceState(null, '', '/')
  if (!('caches' in window)) return 0
  const cache = await caches.open(SHARE_CACHE)
  const metaRes = await cache.match('/shared/meta')
  if (!metaRes) return 0
  const { text, count } = await metaRes.json()
  let added = 0
  const link = extractUrl(text)
  try {
    if (link && !count) {
      await api.ingestLink(link); added++
    }
    for (let i = 0; i < count; i++) {
      const res = await cache.match(`/shared/file-${i}`)
      if (!res) continue
      const blob = await res.blob()
      const name = decodeURIComponent(res.headers.get('X-File-Name') || `shared-${i}`)
      const form = new FormData()
      form.append('file', new File([blob], name, { type: blob.type }))
      if (link) form.append('original_source_url', link)
      await api.upload(form); added++
    }
    if (!added) notify('error', 'Nothing to add — share a link, photo or video')
  } catch (err) {
    notify('error', `Couldn't add shared item: ${err.message}`)
  } finally {
    await caches.delete(SHARE_CACHE)
  }
  return added
}
