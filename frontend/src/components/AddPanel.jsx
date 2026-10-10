import { useState } from 'react'
import { api } from '../api'

const ACCEPT = 'image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime,video/webm'
const COPY = {
  closet: { title: 'Add to your closet', hint: 'Photos or videos of pieces you own. Flat lays and try-on videos work - every piece is catalogued.', link: 'Or a link to a photo/video of your piece' },
  inspo: { title: 'Save inspo', hint: 'TikToks, Reels, Pins or screenshots of looks you want. Each is broken down and mapped onto your closet.', link: 'Paste a TikTok / Instagram / Pinterest link' },
}

export default function AddPanel({ defaultKind = 'closet', onQueued, notify }) {
  const [kind, setKind] = useState(defaultKind)
  const [files, setFiles] = useState([])
  const [link, setLink] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState('')
  const c = COPY[kind]

  const submit = async (e) => {
    e.preventDefault()
    if (!files.length && !link) return
    let ok = 0
    try {
      if (link) {
        setBusy('Sending link…')
        await api.ingestLink(link, kind, notes); ok++
      }
      for (const [i, file] of files.entries()) {
        setBusy(`Uploading ${i + 1}/${files.length}…`)
        const form = new FormData()
        form.append('file', file)
        form.append('kind', kind)
        form.append('notes', notes)
        try { await api.upload(form); ok++ } catch (err) { notify('error', `${file.name}: ${err.message}`) }
      }
    } catch (err) {
      notify('error', `Could not add: ${err.message}`)
    } finally {
      setBusy('')
      if (ok) {
        notify('info', `${ok} queued — analysing in the background`)
        setFiles([]); setLink(''); setNotes('')
        e.target.reset()
        onQueued?.()
      }
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-neutral-800 bg-neutral-900/50 p-4">
      <div className="flex rounded-lg bg-neutral-950 p-1 text-sm">
        {['closet', 'inspo'].map((k) => (
          <button key={k} type="button" onClick={() => setKind(k)}
            className={`flex-1 rounded-md py-1.5 ${kind === k ? 'bg-fuchsia-600 text-white' : 'text-neutral-400 hover:text-white'}`}>
            {k === 'closet' ? 'My closet' : 'Inspo'}
          </button>
        ))}
      </div>
      <div>
        <h2 className="font-semibold">{c.title}</h2>
        <p className="text-xs text-neutral-400">{c.hint}</p>
      </div>
      <input type="url" className="input" placeholder={c.link} value={link} onChange={(e) => setLink(e.target.value)} />
      <input type="file" multiple accept={ACCEPT} aria-label="Photos or videos"
        onChange={(e) => setFiles([...e.target.files])}
        className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-neutral-800 file:px-3 file:py-2 file:text-neutral-100 hover:file:bg-neutral-700" />
      {files.length > 1 && <p className="text-xs text-neutral-400">{files.length} files — each is analysed separately</p>}
      <input className="input" placeholder={kind === 'closet' ? 'Note (optional), e.g. "the grey one is wool"' : 'What you like about it (optional)'}
        value={notes} onChange={(e) => setNotes(e.target.value)} />
      <button className="btn-primary w-full" disabled={!!busy || (!files.length && !link)}>{busy || 'Add & analyse'}</button>
    </form>
  )
}
