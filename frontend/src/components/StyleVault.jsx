import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import TagInput from './TagInput'
import PieceList from './PieceList'

const POLL_MS = 3000
const ACCEPT = 'image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime,video/webm'

function AddForm({ allTags, onDone, notify }) {
  const [files, setFiles] = useState([])
  const [link, setLink] = useState('')
  const [tags, setTags] = useState([])
  const [source, setSource] = useState('')
  const [items, setItems] = useState('')
  const [busy, setBusy] = useState('')

  const submit = async (e) => {
    e.preventDefault()
    if (!files.length && !link) return
    const clothing = items.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [name, url] = l.split('|').map((s) => s.trim())
      return url ? { name, url } : { name }
    })
    let ok = 0
    try {
      if (link) {
        setBusy('Sending link…')
        await api.ingestLink(link, tags); ok++
      }
      for (const [i, file] of files.entries()) {
        setBusy(`Uploading ${i + 1}/${files.length}…`)
        const form = new FormData()
        form.append('file', file)
        form.append('aesthetic_tags', tags.join(','))
        form.append('original_source_url', source)
        form.append('clothing_items', JSON.stringify(clothing))
        try { await api.upload(form); ok++ } catch (err) { notify('error', `${file.name}: ${err.message}`) }
      }
    } catch (err) {
      notify('error', `Could not add: ${err.message}`)
    } finally {
      setBusy('')
      if (ok) {
        notify('info', `${ok} added — analysing pieces in the background`)
        setFiles([]); setLink(''); setTags([]); setSource(''); setItems('')
        e.target.reset()
        onDone()
      }
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-neutral-800 bg-neutral-900/50 p-4">
      <h2 className="font-semibold">Add to your vault</h2>
      <p className="text-xs text-neutral-400">Outfit videos, photos, screenshots or product pics. Every piece gets identified and catalogued.</p>
      <input type="url" className="input" placeholder="Paste a TikTok / Instagram / Pinterest link" value={link} onChange={(e) => setLink(e.target.value)} />
      <div className="text-center text-xs text-neutral-500">and/or</div>
      <input type="file" multiple accept={ACCEPT}
        onChange={(e) => setFiles([...e.target.files])}
        className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-neutral-800 file:px-3 file:py-2 file:text-neutral-100 hover:file:bg-neutral-700" />
      {files.length > 1 && <p className="text-xs text-neutral-400">{files.length} files selected — each becomes its own entry</p>}
      <TagInput tags={tags} onChange={setTags} suggestions={allTags} />
      <details className="text-sm">
        <summary className="cursor-pointer text-xs text-neutral-400">Optional details</summary>
        <div className="mt-2 space-y-2">
          <input className="input" type="url" placeholder="Original source URL (for uploaded files)" value={source} onChange={(e) => setSource(e.target.value)} />
          <textarea className="input" rows={3} placeholder={'Pieces you already know, one per line\ne.g. Leather jacket | https://shop.com/jacket'} value={items} onChange={(e) => setItems(e.target.value)} />
        </div>
      </details>
      <button className="btn-primary w-full" disabled={!!busy || (!files.length && !link)}>{busy || 'Add & analyse'}</button>
    </form>
  )
}

function StatusBadge({ outfit, onRetry }) {
  const s = outfit.analysis_status
  if (s === 'done') return null
  if (s === 'failed') return (
    <div className="rounded-lg bg-red-950/60 p-2 text-xs text-red-300">
      Analysis failed: {outfit.analysis_error || 'unknown error'}
      <button className="ml-2 underline hover:text-white" onClick={onRetry}>Retry</button>
    </div>
  )
  return (
    <div className="flex items-center gap-2 text-xs text-fuchsia-300">
      <span className="h-2 w-2 animate-pulse rounded-full bg-fuchsia-400" />
      {s === 'pending' ? 'Queued…' : 'Downloading & identifying pieces…'}
    </div>
  )
}

function Media({ outfit }) {
  if (outfit.video_url) {
    return <video src={outfit.video_url} poster={outfit.image_url || undefined} controls muted playsInline preload="none" className="aspect-[9/16] w-full bg-black object-cover" />
  }
  if (outfit.image_url) return <img src={outfit.image_url} alt={outfit.summary || ''} loading="lazy" className="aspect-[3/4] w-full object-cover" />
  return <div className="flex aspect-[3/4] w-full items-center justify-center bg-neutral-800 text-xs text-neutral-500">{outfit.media_type === 'video' ? 'Fetching video…' : 'Processing…'}</div>
}

function OutfitCard({ outfit, allTags, onChange, notify }) {
  const [editing, setEditing] = useState(false)
  const [tags, setTags] = useState(outfit.aesthetic_tags)
  useEffect(() => { if (!editing) setTags(outfit.aesthetic_tags) }, [outfit.aesthetic_tags, editing])

  const save = async () => {
    try { await api.updateOutfit(outfit.id, { aesthetic_tags: tags }); setEditing(false); onChange() }
    catch (err) { notify('error', err.message) }
  }
  const remove = async () => {
    if (!confirm('Delete this from the vault?')) return
    try { await api.deleteOutfit(outfit.id); onChange() } catch (err) { notify('error', err.message) }
  }
  const retry = async () => {
    try { await api.reanalyze(outfit.id); onChange() } catch (err) { notify('error', err.message) }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900">
      <Media outfit={outfit} />
      <div className="space-y-2 p-3">
        <StatusBadge outfit={outfit} onRetry={retry} />
        {outfit.summary && <p className="text-xs text-neutral-300">{outfit.summary}</p>}
        {editing ? (
          <>
            <TagInput tags={tags} onChange={setTags} suggestions={allTags} />
            <div className="flex gap-2">
              <button className="btn-primary flex-1" onClick={save}>Save</button>
              <button className="btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {outfit.aesthetic_tags.map((t) => <span key={t} className="rounded-full bg-fuchsia-900/60 px-2.5 py-0.5 text-xs">#{t}</span>)}
          </div>
        )}
        {outfit.color_palette?.length > 0 && (
          <div className="text-[11px] text-neutral-500">Palette: {outfit.color_palette.join(', ')}</div>
        )}
        <PieceList items={outfit.clothing_items} />
        <div className="flex items-center justify-between pt-1 text-xs text-neutral-500">
          {outfit.original_source_url
            ? <a className="underline hover:text-white" href={outfit.original_source_url} target="_blank" rel="noreferrer noopener">Source</a>
            : <span />}
          <span className="space-x-3">
            {outfit.analysis_status === 'done' && <button className="hover:text-white" onClick={retry}>Re-analyse</button>}
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

  // Poll while anything is still being analysed.
  const inFlight = outfits.some((o) => o.analysis_status === 'pending' || o.analysis_status === 'processing')
  useEffect(() => {
    if (!inFlight) return
    const t = setInterval(load, POLL_MS)
    return () => clearInterval(t)
  }, [inFlight, load])

  const names = tags.map((t) => t.tag)

  return (
    <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
      <div className="lg:sticky lg:top-4 lg:self-start"><AddForm allTags={names} onDone={load} notify={notify} /></div>
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
          : outfits.length === 0 ? <p className="text-neutral-500">Nothing here yet — drop in a TikTok link or upload your first fit.</p>
          : <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {outfits.map((o) => <OutfitCard key={o.id} outfit={o} allTags={names} onChange={load} notify={notify} />)}
            </div>}
      </section>
    </div>
  )
}
