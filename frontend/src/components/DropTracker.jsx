import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'

const BADGE = {
  live: 'bg-emerald-900/70 text-emerald-300',
  upcoming: 'bg-amber-900/70 text-amber-300',
  sold_out: 'bg-red-900/70 text-red-300',
  error: 'bg-red-950 text-red-400',
  unknown: 'bg-neutral-800 text-neutral-400',
}
const POLL_MS = 30_000

function AddDropForm({ onAdded, notify }) {
  const empty = { creator_name: '', collection_title: '', target_url: '', drop_timestamp: '' }
  const [f, setF] = useState(empty)
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api.addDrop({ ...f, drop_timestamp: f.drop_timestamp ? new Date(f.drop_timestamp).toISOString() : null })
      setF(empty); onAdded()
    } catch (err) { notify('error', `Could not add drop: ${err.message}`) }
    finally { setBusy(false) }
  }

  return (
    <form onSubmit={submit} className="grid gap-3 rounded-xl border border-neutral-800 bg-neutral-900/50 p-4 md:grid-cols-2">
      <input className="input" required placeholder="Creator / brand" value={f.creator_name} onChange={set('creator_name')} />
      <input className="input" required placeholder="Collection title" value={f.collection_title} onChange={set('collection_title')} />
      <input className="input md:col-span-2" required type="url" placeholder="Target URL to watch" value={f.target_url} onChange={set('target_url')} />
      <label className="text-xs text-neutral-400">Expected drop time (optional)
        <input className="input mt-1" type="datetime-local" value={f.drop_timestamp} onChange={set('drop_timestamp')} />
      </label>
      <button className="btn-primary self-end" disabled={busy}>{busy ? 'Adding…' : 'Track drop'}</button>
    </form>
  )
}

export default function DropTracker({ notify }) {
  const [drops, setDrops] = useState([])
  const [syncing, setSyncing] = useState(false)
  const prev = useRef(null)  // last seen {id: {status, price}} for client-side change detection

  // Diff against what we last saw so changes made by the server's periodic worker also surface.
  const apply = useCallback((next) => {
    if (prev.current) {
      for (const d of next) {
        const old = prev.current[d.id]
        if (!old) continue
        const parts = []
        if (old.status !== d.status) parts.push(`${old.status} → ${d.status}`)
        if (old.price !== d.last_known_price) parts.push(`price ${old.price ?? 'n/a'} → ${d.last_known_price ?? 'n/a'}`)
        if (parts.length) notify('change', `${d.collection_title}: ${parts.join(', ')}`)
      }
    }
    prev.current = Object.fromEntries(next.map((d) => [d.id, { status: d.status, price: d.last_known_price }]))
    setDrops(next)
  }, [notify])

  const load = useCallback(async () => {
    try { apply(await api.drops()) } catch (err) { notify('error', `Could not load drops: ${err.message}`) }
  }, [apply, notify])

  useEffect(() => {
    load()
    const t = setInterval(load, POLL_MS)
    return () => clearInterval(t)
  }, [load])

  const sync = async () => {
    setSyncing(true)
    try {
      const res = await api.syncDrops()
      prev.current = null  // server reported the changes itself; avoid double toasts
      apply(res.drops)
      if (res.changes.length) res.changes.forEach((c) => notify('change', c.message))
      else notify('info', `Checked ${res.checked} drop${res.checked === 1 ? '' : 's'} — no changes`)
    } catch (err) { notify('error', `Sync failed: ${err.message}`) }
    finally { setSyncing(false) }
  }

  const remove = async (id) => {
    try { await api.deleteDrop(id); load() } catch (err) { notify('error', err.message) }
  }

  return (
    <div className="space-y-6">
      <AddDropForm onAdded={load} notify={notify} />
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Tracked drops ({drops.length})</h2>
        <button className="btn-primary" onClick={sync} disabled={syncing || !drops.length}>{syncing ? 'Syncing…' : 'Sync Drops Now'}</button>
      </div>
      <div className="overflow-x-auto rounded-xl border border-neutral-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-neutral-900 text-xs uppercase text-neutral-400">
            <tr><th className="p-3">Creator</th><th className="p-3">Collection</th><th className="p-3">Drop time</th><th className="p-3">Price</th><th className="p-3">Status</th><th /></tr>
          </thead>
          <tbody>
            {drops.map((d) => (
              <tr key={d.id} className="border-t border-neutral-800">
                <td className="p-3">{d.creator_name}</td>
                <td className="p-3"><a className="underline hover:text-fuchsia-300" href={d.target_url} target="_blank" rel="noreferrer noopener">{d.collection_title}</a></td>
                <td className="p-3 text-neutral-400">{d.drop_timestamp ? new Date(d.drop_timestamp).toLocaleString() : '—'}</td>
                <td className="p-3">{d.last_known_price != null ? `$${d.last_known_price}` : '—'}</td>
                <td className="p-3"><span className={`rounded-full px-2.5 py-0.5 text-xs ${BADGE[d.status]}`}>{d.status.replace('_', ' ')}</span></td>
                <td className="p-3 text-right"><button className="text-xs text-neutral-500 hover:text-red-400" onClick={() => remove(d.id)}>Remove</button></td>
              </tr>
            ))}
            {!drops.length && <tr><td colSpan={6} className="p-6 text-center text-neutral-500">No drops tracked yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
