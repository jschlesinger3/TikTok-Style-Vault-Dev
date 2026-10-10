import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { BrandBadge, ShopLinks } from './PieceList'

function Chips({ title, rows, label }) {
  if (!rows?.length) return null
  return (
    <div>
      <h3 className="mb-1.5 text-xs uppercase tracking-wide text-neutral-500">{title}</h3>
      <div className="flex flex-wrap gap-1.5">
        {rows.map((r) => (
          <span key={r[label]} className="rounded-full bg-neutral-800 px-2.5 py-0.5 text-xs">{r[label]} <span className="text-neutral-500">{r.n}</span></span>
        ))}
      </div>
    </div>
  )
}

export default function Catalog({ notify }) {
  const [data, setData] = useState(null)
  const [category, setCategory] = useState(null)
  const [q, setQ] = useState('')

  const load = useCallback(async () => {
    try { setData(await api.catalog(category)) } catch (err) { notify('error', `Could not load catalog: ${err.message}`) }
  }, [category, notify])
  useEffect(() => { load() }, [load])

  if (!data) return <p className="text-neutral-500">Loading…</p>
  const { profile } = data
  const needle = q.trim().toLowerCase()
  const filtered = needle
    ? data.items.filter((i) => [i.name, i.brand, i.color, i.material, ...(i.aesthetic_tags || [])].some((v) => v?.toLowerCase().includes(needle)))
    : data.items
  // The same piece shows up across many videos - group it so the catalog reads like a wardrobe.
  const groups = new Map()
  for (const it of filtered) {
    const key = (it.brand && it.product_name ? `${it.brand} ${it.product_name}` : `${it.name} ${it.color || ''}`).toLowerCase().trim()
    const g = groups.get(key)
    if (g) g.count++
    else groups.set(key, { ...it, count: 1 })
  }
  const items = [...groups.values()].sort((a, b) => b.count - a.count)

  return (
    <div className="space-y-6">
      <section className="grid gap-4 rounded-xl border border-neutral-800 bg-neutral-900/50 p-4 md:grid-cols-3">
        <Chips title="Your aesthetics" rows={profile.top_tags} label="tag" />
        <Chips title="Your colours" rows={profile.top_colors} label="color" />
        <Chips title="Brands you wear" rows={profile.top_brands} label="brand" />
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => setCategory(null)} className={`rounded-full px-3 py-1 text-xs ${!category ? 'bg-fuchsia-600' : 'bg-neutral-800 hover:bg-neutral-700'}`}>All pieces</button>
        {profile.categories.filter((c) => c.category).map((c) => (
          <button key={c.category} onClick={() => setCategory(c.category)}
            className={`rounded-full px-3 py-1 text-xs capitalize ${category === c.category ? 'bg-fuchsia-600' : 'bg-neutral-800 hover:bg-neutral-700'}`}>
            {c.category} <span className="text-neutral-400">{c.n}</span>
          </button>
        ))}
        <input className="input ml-auto max-w-xs" placeholder="Search pieces, brands, colours…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {items.length === 0 ? <p className="text-neutral-500">No pieces yet — add outfits in the Style Vault and they'll be catalogued here.</p> : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((p, i) => (
            <div key={`${p.outfit_id}-${i}-${p.name}`} className="flex gap-3 rounded-xl border border-neutral-800 bg-neutral-900 p-3">
              {p.image_url
                ? <img src={p.image_url} alt="" loading="lazy" className="h-24 w-16 flex-none rounded-md object-cover" />
                : <div className="h-24 w-16 flex-none rounded-md bg-neutral-800" />}
              <div className="min-w-0 space-y-1 text-xs">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm text-neutral-100">{p.name}</span>
                  {p.count > 1 && <span className="flex-none text-[10px] text-fuchsia-300">in {p.count} looks</span>}
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-neutral-400">
                  {p.category && <span className="capitalize">{p.category}</span>}
                  {p.color && <span>· {p.color}</span>}
                  {p.material && <span>· {p.material}</span>}
                  <BrandBadge piece={p} />
                </div>
                {p.fit && <div className="text-neutral-500">{p.fit}</div>}
                <ShopLinks links={p.links} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
