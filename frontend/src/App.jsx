import { useCallback, useEffect, useState } from 'react'
import AddPanel from './components/AddPanel'
import Closet from './components/Closet'
import DropTracker from './components/DropTracker'
import Inspo from './components/Inspo'
import JobsStrip from './components/JobsStrip'
import MyStyle from './components/MyStyle'
import Toasts from './components/Toasts'
import { readShare, submitShare } from './share'

const TABS = [['closet', 'Closet'], ['inspo', 'Inspo'], ['style', 'My Style'], ['drops', 'Drops']]
let nextId = 1

function initialTab() {
  const t = new URLSearchParams(location.search).get('tab')
  return TABS.some(([id]) => id === t) ? t : 'closet'
}

function ShareChooser({ share, onPick, onCancel }) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/70 p-4 sm:items-center">
      <div className="w-full max-w-sm space-y-3 rounded-2xl border border-neutral-800 bg-neutral-900 p-5">
        <h2 className="font-semibold">Add {share.files.length} shared file{share.files.length > 1 ? 's' : ''} as…</h2>
        <button className="btn-primary w-full" onClick={() => onPick('closet')}>Pieces I own</button>
        <button className="btn-ghost w-full" onClick={() => onPick('inspo')}>Inspo look</button>
        <button className="w-full text-xs text-neutral-500 hover:text-white" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

export default function App() {
  const [tab, setTabState] = useState(initialTab)
  const [toasts, setToasts] = useState([])
  const [refreshKey, setRefreshKey] = useState(0)
  const [share, setShare] = useState(null)
  const notify = useCallback((kind, message) => setToasts((t) => [...t, { id: nextId++, kind, message }]), [])
  const close = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), [])
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), [])

  const setTab = (t) => {
    setTabState(t)
    const p = new URLSearchParams(location.search); p.set('tab', t)
    history.replaceState(null, '', `${location.pathname}?${p}`)
  }

  const send = useCallback(async (s, kind) => {
    setShare(null)
    try {
      const n = await submitShare(s, kind)
      if (n) { notify('info', `Added ${n} from share — analysing now`); setTabState(kind === 'closet' ? 'closet' : 'inspo'); refresh() }
    } catch (err) { notify('error', `Couldn't add shared item: ${err.message}`) }
  }, [notify, refresh])

  // Opened from the phone's share sheet: links go to Inspo; files ask closet vs inspo.
  useEffect(() => {
    readShare().then((s) => {
      if (!s) return
      if (s.files.length) setShare(s)
      else if (s.link) send(s, 'inspo')
      else notify('error', 'Nothing to add — share a link, photo or video')
    })
  }, [send, notify])

  const showAdd = tab === 'closet' || tab === 'inspo'

  return (
    <div className="min-h-screen">
      <header className="border-b border-neutral-800 pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="whitespace-nowrap bg-gradient-to-r from-fuchsia-400 to-cyan-400 bg-clip-text text-xl font-bold text-transparent">Style Vault</h1>
          <nav className="flex gap-1 overflow-x-auto rounded-lg bg-neutral-900 p-1">
            {TABS.map(([id, label]) => (
              <button key={id} onClick={() => setTab(id)}
                className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm sm:px-4 ${tab === id ? 'bg-fuchsia-600 text-white' : 'text-neutral-400 hover:text-white'}`}>{label}</button>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">
        {tab !== 'drops' && <JobsStrip refreshKey={refreshKey} onDone={refresh} notify={notify} />}
        <div className={showAdd ? 'grid gap-6 lg:grid-cols-[320px_1fr]' : ''}>
          {showAdd && (
            <div className="lg:sticky lg:top-4 lg:self-start">
              <AddPanel key={tab} defaultKind={tab} onQueued={refresh} notify={notify} />
            </div>
          )}
          <div className="min-w-0">
            {tab === 'closet' && <Closet refreshKey={refreshKey} notify={notify} />}
            {tab === 'inspo' && <Inspo refreshKey={refreshKey} notify={notify} />}
            {tab === 'style' && <MyStyle refreshKey={refreshKey} notify={notify} />}
            {tab === 'drops' && <DropTracker notify={notify} />}
          </div>
        </div>
      </main>
      {share && <ShareChooser share={share} onPick={(k) => send(share, k)} onCancel={() => setShare(null)} />}
      <Toasts toasts={toasts} onClose={close} />
    </div>
  )
}
