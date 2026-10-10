// Small shared pieces used across tabs.
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

export function Thumb({ src, className = 'h-16 w-12', alt = '' }) {
  return src
    ? <img src={src} alt={alt} loading="lazy" className={`${className} flex-none rounded-md bg-neutral-800 object-cover`} />
    : <div className={`${className} flex-none rounded-md bg-neutral-800`} />
}

export function Chip({ active, onClick, children }) {
  return (
    <button type="button" onClick={onClick}
      className={`whitespace-nowrap rounded-full px-3 py-1 text-xs capitalize ${active ? 'bg-fuchsia-600 text-white' : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'}`}>
      {children}
    </button>
  )
}

export function Section({ title, children, right }) {
  return (
    <section className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  )
}

export const itemName = (i) => [i.primary_color, i.sub_category].filter(Boolean).join(' ')

export function daysAgo(d) {
  if (!d) return null
  const days = Math.round((Date.now() - new Date(d).getTime()) / 86400000)
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days}d ago`
}
