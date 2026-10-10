// Minimal service worker: makes the app installable and receives Android "Share to Style Vault".
// Shared links/files are parked in Cache Storage, then the page picks them up from /?shared=1.
const SHARE_CACHE = 'shared-inbox'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'POST' || url.pathname !== '/share') return
  event.respondWith((async () => {
    const form = await event.request.formData()
    const cache = await caches.open(SHARE_CACHE)
    const files = form.getAll('media').filter((f) => f && f.size)
    const text = ['url', 'text', 'title'].map((k) => form.get(k)).filter(Boolean).join(' ')
    await cache.put('/shared/meta', new Response(JSON.stringify({ text, count: files.length })))
    await Promise.all(files.map((f, i) => cache.put(`/shared/file-${i}`,
      new Response(f, { headers: { 'Content-Type': f.type, 'X-File-Name': encodeURIComponent(f.name || `shared-${i}`) } }))))
    return Response.redirect('/?shared=1', 303)
  })())
})
