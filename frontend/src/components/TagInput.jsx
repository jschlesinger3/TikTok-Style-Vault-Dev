import { useState } from 'react'

export default function TagInput({ tags, onChange, suggestions = [] }) {
  const [draft, setDraft] = useState('')
  const add = (raw) => {
    const t = raw.trim().toLowerCase().replace(/^#/, '')
    if (t && !tags.includes(t)) onChange([...tags, t])
    setDraft('')
  }
  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {tags.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-full bg-fuchsia-900/60 px-2.5 py-0.5 text-xs">
            #{t}
            <button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))} className="text-fuchsia-300 hover:text-white">×</button>
          </span>
        ))}
      </div>
      <input
        className="input" value={draft} list="tag-suggestions" placeholder="Add aesthetic tag, press Enter"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(draft) } }}
        onBlur={() => draft && add(draft)}
      />
      <datalist id="tag-suggestions">{suggestions.map((s) => <option key={s} value={s} />)}</datalist>
    </div>
  )
}
