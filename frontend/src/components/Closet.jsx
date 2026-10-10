import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import TagInput from './TagInput'
import { Chip, daysAgo, itemName } from './ui'

const CATEGORIES = ['top', 'bottom', 'outerwear', 'tailoring', 'footwear', 'accessory', 'other']
const STATUSES = ['active', 'laundry', 'archived', 'purged']

function ItemCard({ item, allTags, selecting, selected, onToggle, onChange, notify }) {
  const [editing, setEditing] = useState(false)
  const [tags, setTags] = useState(item.aesthetic_tags)
  const update = async (patch) => {
    try { await api.updateItem(item.id, patch); onChange() } catch (err) { notify('error', err.message) }
  }
  const remove = async () => {
    if (!confirm('Delete this item? (Only for mis-detections - use "purged" for things you got rid of.)')) return
    try { await api.deleteItem(item.id); onChange() } catch (err) { notify('error', err.message) }
  }

  return (
    <div onClick={selecting ? () => onToggle(item.id) : undefined}
      className={`overflow-hidden rounded-xl border bg-neutral-900 ${selecting ? 'cursor-pointer' : ''} ${selected ? 'border-fuchsia-500 ring-2 ring-fuchsia-500' : 'border-neutral-800'}`}>
      <div className="relative">
        {item.image_url
          ? <img src={item.image_url} alt={itemName(item)} loading="lazy" className="aspect-[4/5] w-full bg-neutral-800 object-cover" />
          : <div className="aspect-[4/5] w-full bg-neutral-800" />}
        {item.versatility_score && (
          <span title="Versatility for your style" className="absolute right-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-[10px] text-white">
            {item.versatility_score}/10
          </span>
        )}
        {selecting && <span className={`absolute left-2 top-2 h-5 w-5 rounded-full border-2 ${selected ? 'border-fuchsia-400 bg-fuchsia-500' : 'border-white/70 bg-black/40'}`} />}
      </div>
      <div className="space-y-1.5 p-3 text-xs">
        <div className="text-sm leading-snug text-neutral-100">{itemName(item)}</div>
        <div className="flex flex-wrap gap-x-2 text-neutral-400">
          <span className="capitalize">{item.category}</span>
          {item.fabric && <span>· {item.fabric}</span>}
          {item.silhouette && <span>· {item.silhouette}</span>}
        </div>
        {item.brand && <div className="text-emerald-300">{item.brand}{item.product_name ? ` ${item.product_name}` : ''}</div>}
        <div className="text-neutral-500">
          {item.wear_count ? `Worn ${item.wear_count}× · last ${daysAgo(item.last_worn)}` : 'Not worn yet'}
        </div>
        {!selecting && (editing ? (
          <div onClick={(e) => e.stopPropagation()} className="space-y-2">
            <TagInput tags={tags} onChange={setTags} suggestions={allTags} />
            <div className="flex gap-2">
              <button className="btn-primary flex-1 py-1" onClick={() => { update({ aesthetic_tags: tags }); setEditing(false) }}>Save</button>
              <button className="btn-ghost py-1" onClick={() => { setTags(item.aesthetic_tags); setEditing(false) }}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1">
            {item.aesthetic_tags.map((t) => <span key={t} className="rounded-full bg-fuchsia-900/50 px-2 py-0.5 text-[10px]">#{t}</span>)}
          </div>
        ))}
        {!selecting && (
          <div className="flex items-center justify-between gap-2 pt-1">
            <select aria-label="Status" value={item.status} onChange={(e) => update({ status: e.target.value })}
              className="rounded bg-neutral-800 px-1.5 py-1 text-[11px] text-neutral-200">
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <span className="space-x-2 text-neutral-500">
              <button className="hover:text-white" onClick={() => setEditing(true)}>Tags</button>
              <button className="hover:text-red-400" onClick={remove}>Delete</button>
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

function LogWearBar({ count, onCancel, onSave }) {
  const [rating, setRating] = useState('')
  const [event, setEvent] = useState('')
  return (
    <div className="sticky top-2 z-10 mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-fuchsia-700 bg-neutral-950/95 p-3 text-sm backdrop-blur">
      <span className="font-medium">{count} selected</span>
      <input className="input max-w-[12rem] py-1" placeholder="Occasion (optional)" value={event} onChange={(e) => setEvent(e.target.value)} />
      <select aria-label="Rating" className="input w-auto py-1" value={rating} onChange={(e) => setRating(e.target.value)}>
        <option value="">Rating</option>
        {[10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n}/10</option>)}
      </select>
      <button className="btn-primary py-1" disabled={!count} onClick={() => onSave({ event, rating })}>Log as worn today</button>
      <button className="btn-ghost py-1" onClick={onCancel}>Cancel</button>
    </div>
  )
}

export default function Closet({ refreshKey, notify }) {
  const [items, setItems] = useState(null)
  const [tags, setTags] = useState([])
  const [category, setCategory] = useState(null)
  const [status, setStatus] = useState('active')
  const [tag, setTag] = useState(null)
  const [q, setQ] = useState('')
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState(new Set())

  const load = useCallback(async () => {
    try {
      const [i, t] = await Promise.all([api.items({ status, category, tag, q: q.trim() }), api.tags()])
      setItems(i); setTags(t)
    } catch (err) { notify('error', `Could not load closet: ${err.message}`) }
  }, [status, category, tag, q, notify])

  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0) // debounce search typing
    return () => clearTimeout(t)
  }, [load, refreshKey, q])

  const toggle = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const saveWear = async ({ event, rating }) => {
    try {
      await api.logWear({ item_ids: [...selected], event_context: event || null, feedback_rating: rating ? Number(rating) : null })
      notify('info', `Logged ${selected.size} piece(s) as worn`)
      setSelecting(false); setSelected(new Set()); load()
    } catch (err) { notify('error', err.message) }
  }

  return (
    <div>
      {selecting && <LogWearBar count={selected.size} onCancel={() => { setSelecting(false); setSelected(new Set()) }} onSave={saveWear} />}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input className="input max-w-xs" placeholder="Search colour, fabric, brand…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Show" className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          {[...STATUSES, 'all'].map((s) => <option key={s} value={s}>{s === 'all' ? 'All statuses' : s}</option>)}
        </select>
        {!selecting && <button className="btn-ghost ml-auto" onClick={() => setSelecting(true)}>Log an outfit</button>}
      </div>
      <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
        <Chip active={!category} onClick={() => setCategory(null)}>All</Chip>
        {CATEGORIES.map((c) => <Chip key={c} active={category === c} onClick={() => setCategory(category === c ? null : c)}>{c}</Chip>)}
      </div>
      {tags.length > 0 && (
        <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
          {tags.slice(0, 20).map((t) => (
            <Chip key={t.tag} active={tag === t.tag} onClick={() => setTag(tag === t.tag ? null : t.tag)}>#{t.tag} <span className="text-neutral-500">{t.count}</span></Chip>
          ))}
        </div>
      )}
      {items === null ? <p className="text-neutral-500">Loading…</p>
        : items.length === 0 ? <p className="text-neutral-500">No pieces here yet — add photos or videos of what you own, or send them to the Telegram bot.</p>
        : (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
            {items.map((i) => (
              <ItemCard key={i.id} item={i} allTags={tags.map((t) => t.tag)} selecting={selecting} selected={selected.has(i.id)}
                onToggle={toggle} onChange={load} notify={notify} />
            ))}
          </div>
        )}
    </div>
  )
}
