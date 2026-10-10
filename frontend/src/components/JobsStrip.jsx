import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'

const POLL_MS = 3000
const LABEL = { pending: 'Queued', processing: 'Analysing', failed: 'Failed', done: 'Done' }

/** Live list of analysis jobs (from the dashboard and from Telegram). Calls onDone when any job finishes. */
export default function JobsStrip({ refreshKey, onDone, notify }) {
  const [jobs, setJobs] = useState([])
  const known = useRef(new Map())

  const load = useCallback(async () => {
    try {
      const next = await api.jobs()
      for (const j of next) {
        const before = known.current.get(j.id)
        if (before && before !== 'done' && j.status === 'done') {
          onDone?.(j)
          notify('info', j.kind === 'closet' ? `Added ${j.result_item_ids.length} piece(s) to your closet` : 'New look on your inspo board')
        }
        if (before && before !== 'failed' && j.status === 'failed') notify('error', `Analysis failed: ${j.error}`)
      }
      known.current = new Map(next.map((j) => [j.id, j.status]))
      setJobs(next.filter((j) => j.status !== 'done'))
    } catch { /* transient; next poll retries */ }
  }, [onDone, notify])

  useEffect(() => { load() }, [load, refreshKey])
  const active = jobs.some((j) => j.status === 'pending' || j.status === 'processing')
  useEffect(() => {
    // Poll fast while something is running, slowly otherwise (Telegram uploads appear here too).
    const t = setInterval(load, active ? POLL_MS : 15000)
    return () => clearInterval(t)
  }, [active, load])

  if (!jobs.length) return null
  const act = async (fn) => { try { await fn(); load() } catch (err) { notify('error', err.message) } }

  return (
    <div className="mb-4 space-y-2">
      {jobs.map((j) => (
        <div key={j.id} className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-xs ${j.status === 'failed' ? 'border-red-900 bg-red-950/40 text-red-200' : 'border-neutral-800 bg-neutral-900 text-neutral-300'}`}>
          {j.status !== 'failed' && <span className="h-2 w-2 flex-none animate-pulse rounded-full bg-fuchsia-400" />}
          <span className="font-medium">{LABEL[j.status]}</span>
          <span className="text-neutral-500">{j.kind === 'closet' ? 'closet' : 'inspo'} · {j.source === 'telegram' ? 'from Telegram' : j.source}</span>
          <span className="min-w-0 flex-1 truncate">{j.status === 'failed' ? j.error : (j.source_url || j.notes || '')}</span>
          {j.status === 'failed' && <>
            <button className="underline hover:text-white" onClick={() => act(() => api.retryJob(j.id))}>Retry</button>
            <button className="underline hover:text-white" onClick={() => act(() => api.dismissJob(j.id))}>Dismiss</button>
          </>}
        </div>
      ))}
    </div>
  )
}
