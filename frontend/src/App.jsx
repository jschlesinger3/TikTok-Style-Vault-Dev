import { useCallback, useState } from 'react'
import StyleVault from './components/StyleVault'
import DropTracker from './components/DropTracker'
import Catalog from './components/Catalog'
import Toasts from './components/Toasts'

const TABS = [['vault', 'Style Vault'], ['catalog', 'My Style'], ['drops', 'Drop Tracker']]
let nextId = 1

export default function App() {
  const [tab, setTab] = useState('vault')
  const [toasts, setToasts] = useState([])
  const notify = useCallback((kind, message) => setToasts((t) => [...t, { id: nextId++, kind, message }]), [])
  const close = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), [])

  return (
    <div className="min-h-screen">
      <header className="border-b border-neutral-800">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="bg-gradient-to-r from-fuchsia-400 to-cyan-400 whitespace-nowrap bg-clip-text text-xl font-bold text-transparent">Style Vault</h1>
          <nav className="flex gap-1 overflow-x-auto rounded-lg bg-neutral-900 p-1">
            {TABS.map(([id, label]) => (
              <button key={id} onClick={() => setTab(id)}
                className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm sm:px-4 ${tab === id ? 'bg-fuchsia-600 text-white' : 'text-neutral-400 hover:text-white'}`}>{label}</button>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">
        {tab === 'vault' && <StyleVault notify={notify} />}
        {tab === 'catalog' && <Catalog notify={notify} />}
        {tab === 'drops' && <DropTracker notify={notify} />}
      </main>
      <Toasts toasts={toasts} onClose={close} />
    </div>
  )
}
