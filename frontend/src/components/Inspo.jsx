import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { Chip, ShopLinks, Thumb, itemName } from './ui'

function InspoCard({ look, onChange, notify }) {
  const [open, setOpen] = useState(false)
  const act = async (fn) => { try { await fn(); onChange() } catch (err) { notify('error', err.message) } }
  const owned = look.recreate_with.filter((r) => r.item)

  return (
    <div className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900">
      {look.video_url
        ? <video src={look.video_url} poster={look.image_url || undefined} controls muted playsInline preload="none" className="aspect-[9/16] max-h-[28rem] w-full bg-black object-cover" />
        : look.image_url
          ? <img src={look.image_url} alt={look.look_summary || ''} loading="lazy" className="aspect-[3/4] w-full bg-neutral-800 object-cover" />
          : <div className="flex aspect-[3/4] w-full items-center justify-center bg-neutral-800 text-xs text-neutral-500">No image</div>}
      <div className="space-y-2.5 p-3 text-xs">
        <p className="text-sm text-neutral-100">{look.look_summary}</p>
        {look.formula && <p className="rounded-lg bg-neutral-950 px-2.5 py-1.5 font-mono text-[11px] text-fuchsia-200">{look.formula}</p>}
        {owned.length > 0 && (
          <div>
            <div className="mb-1 text-neutral-500">From your closet</div>
            <div className="flex gap-2 overflow-x-auto">
              {owned.map((r, i) => (
                <div key={i} className="w-16 flex-none text-[10px] text-neutral-400" title={`${r.piece} → ${itemName(r.item)} (${r.how_close})`}>
                  <Thumb src={r.item.image_url} className="h-20 w-16" />
                  <div className="mt-0.5 truncate">{itemName(r.item)}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        {look.missing_pieces.length > 0 && (
          <div>
            <div className="mb-1 text-neutral-500">To complete it</div>
            <ul className="space-y-1.5">
              {look.missing_pieces.slice(0, open ? undefined : 3).map((m, i) => (
                <li key={i} className="space-y-1"><div className="text-neutral-200">{m.piece}</div><ShopLinks links={m.links} /></li>
              ))}
            </ul>
          </div>
        )}
        {open && (
          <>
            {look.why_it_works && <p className="text-neutral-300"><span className="text-neutral-500">Why it works: </span>{look.why_it_works}</p>}
            {look.fit_for_user && <p className="text-neutral-300"><span className="text-neutral-500">For you: </span>{look.fit_for_user}</p>}
            {look.key_pieces.length > 0 && (
              <ul className="space-y-1.5">
                {look.key_pieces.map((p, i) => (
                  <li key={i} className="space-y-1">
                    <div><span className="text-neutral-200">{p.piece}</span> <span className="text-neutral-500">· {p.role}</span></div>
                    <ShopLinks links={p.links} />
                  </li>
                ))}
              </ul>
            )}
            {look.user_notes && <p className="text-neutral-400">Your note: {look.user_notes}</p>}
          </>
        )}
        <div className="flex flex-wrap gap-1">
          {look.aesthetic_tags.map((t) => <span key={t} className="rounded-full bg-fuchsia-900/50 px-2 py-0.5 text-[10px]">#{t}</span>)}
        </div>
        <div className="flex items-center justify-between pt-1 text-neutral-500">
          <button className="hover:text-white" onClick={() => setOpen(!open)}>{open ? 'Less' : 'Breakdown'}</button>
          <span className="space-x-3">
            {look.source_url && <a className="hover:text-white" href={look.source_url} target="_blank" rel="noreferrer noopener">Source</a>}
            <button className="hover:text-white" onClick={() => act(() => api.updateInspo(look.id, { status: look.status === 'active' ? 'archived' : 'active' }))}>
              {look.status === 'active' ? 'Archive' : 'Restore'}
            </button>
            <button className="hover:text-red-400" onClick={() => confirm('Delete this look?') && act(() => api.deleteInspo(look.id))}>Delete</button>
          </span>
        </div>
      </div>
    </div>
  )
}

export default function Inspo({ refreshKey, notify }) {
  const [looks, setLooks] = useState(null)
  const [status, setStatus] = useState('active')
  const load = useCallback(async () => {
    try { setLooks(await api.inspo(status)) } catch (err) { notify('error', `Could not load inspo: ${err.message}`) }
  }, [status, notify])
  useEffect(() => { load() }, [load, refreshKey])

  return (
    <div>
      <div className="mb-4 flex gap-2">
        <Chip active={status === 'active'} onClick={() => setStatus('active')}>Board</Chip>
        <Chip active={status === 'archived'} onClick={() => setStatus('archived')}>Archived</Chip>
      </div>
      {looks === null ? <p className="text-neutral-500">Loading…</p>
        : looks.length === 0 ? <p className="text-neutral-500">No inspo yet — paste a TikTok link here, or send one to the Telegram bot.</p>
        : <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {looks.map((l) => <InspoCard key={l.id} look={l} onChange={load} notify={notify} />)}
          </div>}
    </div>
  )
}
