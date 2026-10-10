import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import TagInput from './TagInput'

function UploadForm({ allTags, onDone, notify }) {
  const [file, setFile] = useState(null)
  const [tags, setTags] = useState([])
  const [source, setSource] = useState('')
  const [items, setItems] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    if (!file) return
    setBusy(true)
    try {
      const clothing = items.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const [name, url] = l.split('|').map((s) => s.trim())
        return url ? { name, url } : { name }
      })
      const form = new FormData()
      form.append('file', file)
      form.append('aesthetic_tags', tags.join(','))
      form.append('original_source_url', source)
      form.append('clothing_items', JSON.stringify(clothing))
      await api.upload(form)
      notify('info', 'Outfit saved to the vault')
      setFile(null); setTags([]); setSource(''); setItems('')
      e.target.reset()
      onDone()
    } catch (err) {
      notify('error', `Upload failed: ${err.message}`)
    } finally { setBusy(false) }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-neutral-800 bg-neutral-900/50 p-4">
      <h2 className="font-semibold">Add outfit</h2>
      <input type="file" accept="image/jpeg,image/png,image/gif,image/webp" required
        onChange={(e) => setFile(e.target.files[0] || null)}
        className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-neutral-800 file:px-3 file:py-2 file:text-neutral-100 hover:file:bg-neutral-700" />
      <TagInput tags={tags} onChange={setTags} suggestions={allTags} />
      <input className="input" type="url" placeholder="Original source URL (TikTok, Pinterest…)" value={source} onChange={(e) => setSource(e.target.value)} />
      <textarea className="input" rows={3} placeholder={'Clothing items, one per line\ne.g. Leather jacket | https://shop.com/jacket'} value={items} onChange={(e) => setItems(e.target.value)} />
      <button className="btn-primary w-full" disabled={busy || !file}>{busy ? 'Uploading…' : 'Upload'}</button>
    </form>
  )
}

function OutfitCard({ outfit, allTags, onChange, notify }) {
  const [editing, setEditing] = useState(false)
  const [tags, setTags] = useState(outfit.aesthetic_tags)

  const save = async () => {
    try { await api.updateOutfit(outfit.id, { aesthetic_tags: tags }); setEditing(false); onChange() }
    catch (err) { notify('error', err.message) }
  }
  const remove = async () => {
    if (!confirm('Delete this outfit from the vault?')) return
    try { await api.deleteOutfit(outfit.id); onChange() } catch (err) { notify('error', err.message) }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900">
      <img src={outfit.image_url} alt="" loading="lazy" className="aspect-[3/4] w-full object-cover" />
      <div className="space-y-2 p-3">
        {editing ? (
          <>
            <TagInput tags={tags} onChange={setTags} suggestions={allTags} />
            <div className="flex gap-2">
              <button className="btn-primary flex-1" onClick={save}>Save</button>
              <button className="btn-ghost" onClick={() => { setTags(outfit.aesthetic_tags); setEditing(false) }}>Cancel</button>
            </div>
          </>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {outfit.aesthetic_tags.map((t) => <span key={t} className="rounded-full bg-fuchsia-900/60 px-2.5 py-0.5 text-xs">#{t}</span>)}
            {!outfit.aesthetic_tags.length && <span className="text-xs text-neutral-500">No tags</span>}
          </div>
        )}
        {outfit.clothing_items.length > 0 && (
          <ul className="space-y-0.5 text-xs text-neutral-400">
            {outfit.clothing_items.map((c, i) => (
              <li key={i}>• {c.url ? <a className="underline hover:text-white" href={c.url} target="_blank" rel="noreferrer noopener">{c.name}</a> : c.name}</li>
            ))}
          </ul>
        )}
        <div className="flex items-center justify-between pt-1 text-xs text-neutral-500">
          {outfit.original_source_url
            ? <a className="underline hover:text-white" href={outfit.original_source_url} target="_blank" rel="noreferrer noopener">Source</a>
            : <span />}
          <span className="space-x-3">
            <button className="hover:text-white" onClick={() => setEditing(true)}>Edit tags</button>
            <button className="hover:text-red-400" onClick={remove}>Delete</button>
          </span>
        </div>
      </div>
    </div>
  )
}

export default function StyleVault({ notify }) {
  const [outfits, setOutfits] = useState([])
  const [tags, setTags] = useState([])
  const [filter, setFilter] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const [o, t] = await Promise.all([api.outfits(filter), api.tags()])
      setOutfits(o); setTags(t)
    } catch (err) { notify('error', `Could not load vault: ${err.message}`) }
    finally { setLoading(false) }
  }, [filter, notify])

  useEffect(() => { load() }, [load])
  const names = tags.map((t) => t.tag)

  return (
    <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
      <UploadForm allTags={names} onDone={load} notify={notify} />
      <section>
        <div className="mb-4 flex flex-wrap gap-2">
          <button onClick={() => setFilter(null)} className={`rounded-full px-3 py-1 text-xs ${!filter ? 'bg-fuchsia-600' : 'bg-neutral-800 hover:bg-neutral-700'}`}>All</button>
          {tags.map((t) => (
            <button key={t.tag} onClick={() => setFilter(t.tag)} className={`rounded-full px-3 py-1 text-xs ${filter === t.tag ? 'bg-fuchsia-600' : 'bg-neutral-800 hover:bg-neutral-700'}`}>
              #{t.tag} <span className="text-neutral-400">{t.count}</span>
            </button>
          ))}
        </div>
        {loading ? <p className="text-neutral-500">Loading…</p>
          : outfits.length === 0 ? <p className="text-neutral-500">Nothing here yet — upload your first fit.</p>
          : <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
              {outfits.map((o) => <OutfitCard key={o.id} outfit={o} allTags={names} onChange={load} notify={notify} />)}
            </div>}
      </section>
    </div>
  )
}
