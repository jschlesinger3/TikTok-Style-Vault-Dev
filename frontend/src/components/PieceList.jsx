const LINK_LABELS = { google_shopping: 'Shop', google_lens: 'Lens', depop: 'Depop', ebay: 'eBay' }

export function ShopLinks({ links }) {
  if (!links) return null
  return (
    <span className="flex flex-wrap gap-1">
      {Object.entries(LINK_LABELS).filter(([k]) => links[k]).map(([k, label]) => (
        <a key={k} href={links[k]} target="_blank" rel="noreferrer noopener"
          className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-300 hover:bg-fuchsia-700 hover:text-white">{label}</a>
      ))}
    </span>
  )
}

export function BrandBadge({ piece }) {
  if (!piece.brand) return null
  const conf = piece.brand_confidence
  const style = conf === 'high' ? 'bg-emerald-900/70 text-emerald-300' : conf === 'medium' ? 'bg-amber-900/70 text-amber-300' : 'bg-neutral-800 text-neutral-400'
  return (
    <span title={piece.evidence || ''} className={`rounded px-1.5 py-0.5 text-[10px] ${style}`}>
      {piece.brand}{piece.product_name ? ` ${piece.product_name}` : ''}{conf !== 'high' ? ' ?' : ''}
    </span>
  )
}

export default function PieceList({ items }) {
  if (!items.length) return null
  return (
    <ul className="space-y-1.5 text-xs">
      {items.map((c, i) => (
        <li key={i} className="space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-neutral-200">
              {c.url ? <a className="underline hover:text-white" href={c.url} target="_blank" rel="noreferrer noopener">{c.name}</a> : c.name}
            </span>
            <BrandBadge piece={c} />
            {c.color && <span className="text-neutral-500">{c.color}</span>}
          </div>
          <ShopLinks links={c.links} />
        </li>
      ))}
    </ul>
  )
}
