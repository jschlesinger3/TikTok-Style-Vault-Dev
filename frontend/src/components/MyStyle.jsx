import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { Section, ShopLinks, Thumb, daysAgo, itemName } from './ui'

const FIELDS = [['skin_tone', 'Skin tone'], ['hair_color', 'Hair'], ['eye_color', 'Eyes'], ['build', 'Build']]

function ProfileEditor({ notify }) {
  const [p, setP] = useState(null)
  const [aesthetics, setAesthetics] = useState('')
  const [rules, setRules] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.profile().then((x) => {
      setP(x); setAesthetics(x.target_aesthetics.join(', ')); setRules(JSON.stringify(x.color_rules, null, 2))
    }).catch((err) => notify('error', err.message))
  }, [notify])

  if (!p) return <p className="text-xs text-neutral-500">Loading…</p>
  const save = async () => {
    let color_rules
    try { color_rules = rules.trim() ? JSON.parse(rules) : {} } catch { return notify('error', 'Colour rules must be valid JSON') }
    setSaving(true)
    try {
      await api.saveProfile({ ...p, target_aesthetics: aesthetics.split(',').map((s) => s.trim()).filter(Boolean), color_rules })
      notify('info', 'Profile saved — the stylist and analysis use it from now on')
    } catch (err) { notify('error', err.message) } finally { setSaving(false) }
  }

  return (
    <div className="space-y-2 text-sm">
      {FIELDS.map(([k, label]) => (
        <label key={k} className="block text-xs text-neutral-400">{label}
          <input className="input mt-1" value={p[k] || ''} onChange={(e) => setP({ ...p, [k]: e.target.value })} />
        </label>
      ))}
      <label className="block text-xs text-neutral-400">Target aesthetics (comma separated)
        <input className="input mt-1" value={aesthetics} onChange={(e) => setAesthetics(e.target.value)} />
      </label>
      <details className="text-xs text-neutral-400">
        <summary className="cursor-pointer">Colour & fit rules (JSON)</summary>
        <textarea aria-label="Colour rules" className="input mt-1 font-mono text-[11px]" rows={10} value={rules} onChange={(e) => setRules(e.target.value)} />
      </details>
      <button className="btn-primary w-full" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save profile'}</button>
    </div>
  )
}

function Bars({ rows, label }) {
  if (!rows?.length) return <p className="text-xs text-neutral-500">Nothing yet</p>
  const max = Math.max(...rows.map((r) => r.n))
  return (
    <ul className="space-y-1.5 text-xs">
      {rows.map((r) => (
        <li key={r[label]} className="grid grid-cols-[7rem_1fr_2rem] items-center gap-2">
          <span className="truncate capitalize text-neutral-300">{r[label]}</span>
          <span className="h-2 rounded-full bg-neutral-800"><span className="block h-2 rounded-full bg-fuchsia-500" style={{ width: `${(r.n / max) * 100}%` }} /></span>
          <span className="text-right tabular-nums text-neutral-500">{r.n}</span>
        </li>
      ))}
    </ul>
  )
}

function ItemRow({ items, meta }) {
  if (!items.length) return <p className="text-xs text-neutral-500">Nothing here</p>
  return (
    <div className="flex gap-3 overflow-x-auto pb-1">
      {items.map((i) => (
        <div key={i.id} className="w-20 flex-none text-[10px] text-neutral-400">
          <Thumb src={i.image_url} className="h-24 w-20" />
          <div className="mt-1 truncate text-neutral-300">{itemName(i)}</div>
          <div>{meta(i)}</div>
        </div>
      ))}
    </div>
  )
}

export default function MyStyle({ refreshKey, notify }) {
  const [o, setO] = useState(null)
  const [logs, setLogs] = useState([])
  const load = useCallback(async () => {
    try {
      const [ov, wl] = await Promise.all([api.overview(), api.wearLogs(60)])
      setO(ov); setLogs(wl)
    } catch (err) { notify('error', `Could not load overview: ${err.message}`) }
  }, [notify])
  useEffect(() => { load() }, [load, refreshKey])

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
      <div className="space-y-4">
        <Section title="Your profile"><ProfileEditor notify={notify} /></Section>
      </div>
      {!o ? <p className="text-neutral-500">Loading…</p> : (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            {[['Pieces', o.active_items], ['Saved looks', o.inspo_count], ['Wears (30d)', o.wears_30d]].map(([k, v]) => (
              <div key={k} className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-3">
                <div className="text-2xl font-semibold tabular-nums">{v}</div>
                <div className="text-xs text-neutral-500">{k}</div>
              </div>
            ))}
          </div>
          {o.anchor_gap && (
            <div className="rounded-xl border border-amber-700 bg-amber-950/40 p-4 text-sm text-amber-100">
              <div className="font-semibold">⚓ Missing an anchor shoe</div>
              <p className="mt-1 text-amber-200/80">You own wide-leg bottoms but no footwear with the volume to catch the hem, so the stylist
                can't build those outfits. A Camion-style high-shaft structured boot or a chunky lug-sole derby is your #1 buy.</p>
            </div>
          )}
          {o.latest_audit && (
            <Section title={`Style direction · audit ${daysAgo(o.latest_audit.created_at)}`}>
              <p className="text-sm text-neutral-200">{o.latest_audit.style_direction}</p>
            </Section>
          )}
          <Section title="Shopping list" right={<span className="text-xs text-neutral-500">from your audit + inspo gaps</span>}>
            {o.shopping.length === 0
              ? <p className="text-xs text-neutral-500">Run /audit in Telegram or save inspo looks to build this.</p>
              : <ol className="space-y-2.5 text-xs">
                  {o.shopping.map((s, i) => (
                    <li key={i} className="space-y-1">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="text-sm text-neutral-100">{s.piece}</span>
                        {s.budget_tier && <span className="rounded bg-neutral-800 px-1.5 text-[10px] text-neutral-400">{s.budget_tier}</span>}
                      </div>
                      {s.why && <div className="text-neutral-400">{s.why}</div>}
                      <ShopLinks links={s.links} />
                    </li>
                  ))}
                </ol>}
          </Section>
          <div className="grid gap-4 md:grid-cols-3">
            <Section title="Categories"><Bars rows={o.categories} label="category" /></Section>
            <Section title="Colours"><Bars rows={o.colors} label="color" /></Section>
            <Section title="Aesthetics"><Bars rows={o.tags} label="tag" /></Section>
          </div>
          <Section title="Most worn"><ItemRow items={o.most_worn} meta={(i) => `${i.wear_count}× · ${daysAgo(i.last_worn)}`} /></Section>
          <Section title="Never worn (3+ weeks) — purge candidates">
            <ItemRow items={o.never_worn} meta={(i) => `${i.versatility_score ?? '?'}/10 versatility`} />
          </Section>
          <Section title="Wear log · last 60 days">
            {logs.length === 0 ? <p className="text-xs text-neutral-500">Log outfits with /worn in Telegram or "Log an outfit" in Closet.</p> : (
              <ul className="space-y-3">
                {logs.map((l) => (
                  <li key={l.id} className="flex items-center gap-3">
                    <div className="w-20 flex-none text-xs">
                      <div className="text-neutral-200">{new Date(l.worn_date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>
                      {l.feedback_rating && <div className="text-fuchsia-300">{l.feedback_rating}/10</div>}
                    </div>
                    <div className="flex gap-1.5">{l.items.map((i) => <Thumb key={i.id} src={i.image_url} className="h-14 w-11" alt={itemName(i)} />)}</div>
                    <div className="min-w-0 text-xs text-neutral-400">
                      {l.event_context && <div className="truncate text-neutral-300">{l.event_context}</div>}
                      {l.feedback_notes && <div className="truncate">{l.feedback_notes}</div>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      )}
    </div>
  )
}
