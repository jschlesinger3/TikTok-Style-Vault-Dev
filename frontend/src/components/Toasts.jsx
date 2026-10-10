import { useEffect } from 'react'

const STYLES = {
  change: 'border-fuchsia-500/60 bg-fuchsia-950/90',
  error: 'border-red-500/60 bg-red-950/90',
  info: 'border-neutral-700 bg-neutral-900/95',
}

function Toast({ toast, onClose }) {
  useEffect(() => {
    const t = setTimeout(() => onClose(toast.id), 8000)
    return () => clearTimeout(t)
  }, [toast.id, onClose])
  return (
    <div role="status" className={`border rounded-lg px-4 py-3 text-sm shadow-lg backdrop-blur ${STYLES[toast.kind] || STYLES.info}`}>
      <div className="flex justify-between gap-3">
        <span>{toast.message}</span>
        <button onClick={() => onClose(toast.id)} aria-label="Dismiss" className="text-neutral-400 hover:text-white">×</button>
      </div>
    </div>
  )
}

export default function Toasts({ toasts, onClose }) {
  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((t) => <Toast key={t.id} toast={t} onClose={onClose} />)}
    </div>
  )
}
