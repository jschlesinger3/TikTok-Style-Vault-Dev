<!-- GENERATED from prompts.template.md + prompts/*.md by `npm run build:prompts` - edit those, not this file. -->
# Claude prompts

The prompts live in **`wardrobe-bot/prompts/`**. That folder is the single source for both apps:

| Prompt file | Used by | Triggered by |
|---|---|---|
| `style_brief.md` | every prompt (`{STYLE_BRIEF}`) | |
| `closet_item_vision.md` | **Style Vault** analysis | a photo/video sent to the bot, or a "My closet" upload in Style Vault |
| `inspo_vision.md` | **Style Vault** analysis | a link or "inspo" photo sent to the bot, or an "Inspo" link/upload in Style Vault |
| `stylist.md` | **n8n** Code node below | `/fit <event>` |
| `closet_audit.md` | **n8n** Code node below | `/audit [focus]` |

Style Vault reads the files at runtime, so after editing them run `docker compose up -d --build api`. The n8n Code nodes below embed the same text: after editing a prompt, run `npm run build:prompts` and paste the updated Code node into n8n. `npm test` fails if this document is out of date.

> **Model:** `claude-sonnet-5-5`, the current successor to the retired Claude 3.5 Sonnet. For a deeper `/audit`, set `MODEL` there to `claude-opus-5-5`.

---

## 0. One-time n8n setup

**Credential.** *Credentials → New → Header Auth*: name `x-api-key`, value: your Anthropic API key. Call it "Anthropic".

**HTTP Request node** (identical in the fit and audit workflows):

| Setting | Value |
|---|---|
| Method | `POST` |
| URL | `https://api.anthropic.com/v1/messages` |
| Authentication | Generic → Header Auth → "Anthropic" |
| Send Headers | `anthropic-version: 2023-06-01` and `anthropic-beta: server-side-fallback-2026-07-01` |
| Send Body | JSON → *Using JSON* → `{{ JSON.stringify($json.body) }}` |
| Options → Timeout | `120000` |

The `anthropic-beta` header plus `"fallbacks": "default"` in the body enables **server-side fallback**: if the model declines a request, the API retries it on a suitable model within the same call. Remove both if you don't want this.

**Reading the answer.** Requests use *structured outputs* (`output_config.format`), so the reply text is JSON matching the schema. Add this **Code node right after every HTTP Request node**:

```js
// "Parse Claude" - shared by all workflows
const res = $input.first().json
if (res.type === 'error') throw new Error(`Anthropic API error: ${res.error?.message}`)
if (res.stop_reason === 'refusal') throw new Error('Claude declined this request')
if (res.stop_reason === 'max_tokens') throw new Error('Answer was cut off - raise max_tokens in the Build node')
const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
return [{ json: { result: JSON.parse(text), usage: res.usage } }]
```

**Loading context.** One Postgres node ("Execute Query") returns everything in one row, ready for the Build nodes. Postgres credential in n8n: host `localhost` and port `DB_PORT` from `.env` (n8n via npm on the Mac), or `db` / `5432` (bundled n8n); database and user `wardrobe`, password `POSTGRES_PASSWORD`.

```sql
SELECT
  (SELECT to_jsonb(p) - 'id' FROM user_profile p WHERE id = 1)                         AS profile,
  (SELECT coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) FROM closet_available c)        AS closet,
  (SELECT coalesce(jsonb_agg(x ORDER BY x.created_at DESC), '[]'::jsonb) FROM (
      SELECT look_summary, formula, aesthetic_tags, palette, user_notes, created_at
        FROM inspo WHERE status = 'active' ORDER BY created_at DESC LIMIT 15) x)          AS inspo,
  (SELECT coalesce(jsonb_agg(w ORDER BY w.worn_date DESC), '[]'::jsonb) FROM (
      SELECT worn_date, item_ids, event_context, feedback_rating, feedback_notes
        FROM wear_logs WHERE worn_date >= CURRENT_DATE - 30 ORDER BY worn_date DESC LIMIT 30) w) AS recent_wears;
```

---

## Style Brief: "Streetwear Tailoring" (`prompts/style_brief.md`)

```text
{{STYLE_BRIEF_TEXT}}
```

---

## A. Closet item vision (`prompts/closet_item_vision.md`), run by Style Vault

`{PROFILE_JSON}` is your `user_profile` row. Output schema: `ClosetAnalysis` in `backend/app/analyzer.py`. Each piece becomes one `items` row.

```text
{{CLOSET_ITEM_TEXT}}
```

## B. Inspo vision (`prompts/inspo_vision.md`), run by Style Vault

Gets your closet list too, so it can map the look onto pieces you own. Output schema: `InspoAnalysis` in `backend/app/analyzer.py`. The result becomes one `inspo` row.

```text
{{INSPO_TEXT}}
```

---

## C. Stylist (`prompts/stylist.md`): `/fit`

**Workflow:** Webhook (`wardrobe-fit`) → load context (SQL above) → Merge → **Build fit request** → HTTP → Parse Claude → **Validate + format fit** → Telegram reply.

Includes the **couple coordination** rule: for dates, the stylist complements the partner's likely outfit with a subtle colour echo and balanced silhouettes, never matching. Tip: describe what the partner is wearing, e.g. `/fit dinner date, she's in a black slip dress with gold jewellery`.

**Rule of the Anchor, enforced in code:** a wide-leg or baggy bottom is never paired with a low-profile shoe. Claude reports `anchor_check`, and the *Validate* node also checks the closet data itself (`wide-leg` / `chunky` / `low-profile` tags and silhouettes). If an outfit breaks the rule, the node swaps in your best chunky shoe (most versatile, least recently worn). If you own none, it clears the footwear slot and says which anchor shoe to buy.

```text
{{STYLIST_TEXT}}
```

### n8n Code node: "Build fit request"

```js
// Input: payload from the webhook (event_context, chat_id, ...) + context-query row (profile, closet, inspo, recent_wears)
const MODEL = 'claude-sonnet-5-5'
const STYLE_BRIEF = {{STYLE_BRIEF_JS}}

const input = $input.first().json
const SYSTEM = {{STYLIST_SYSTEM_JS}}

const slot = {
  type: 'object', additionalProperties: false, required: ['item_id', 'why'],
  properties: { item_id: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] }, why: { type: 'string' } },
}
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['event_read', 'look_name', 'outfit', 'anchor_check', 'styling_instructions', 'why_it_works_for_you',
    'partner_coordination', 'inspo_reference', 'swap_option', 'missing_piece_suggestion'],
  properties: {
    event_read: {
      type: 'object', additionalProperties: false, required: ['formality', 'is_date', 'summary'],
      properties: {
        formality: { type: 'integer', enum: [1, 2, 3, 4, 5] },
        is_date: { type: 'boolean' },
        summary: { type: 'string' },
      },
    },
    look_name: { type: 'string' },
    outfit: {
      type: 'object', additionalProperties: false, required: ['top', 'bottom', 'footwear', 'statement'],
      properties: { top: slot, bottom: slot, footwear: slot, statement: slot },
    },
    anchor_check: {
      type: 'object', additionalProperties: false, required: ['bottom_is_wide', 'footwear_has_volume', 'hem_note'],
      properties: {
        bottom_is_wide: { type: 'boolean' },
        footwear_has_volume: { type: 'boolean' },
        hem_note: { type: 'string' },
      },
    },
    styling_instructions: { type: 'array', items: { type: 'string' } },
    why_it_works_for_you: { type: 'string' },
    partner_coordination: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object', additionalProperties: false,
          required: ['partner_likely_look', 'assumed', 'color_echo', 'silhouette_balance'],
          properties: {
            partner_likely_look: { type: 'string' },
            assumed: { type: 'boolean' },
            color_echo: { type: 'string' },
            silhouette_balance: { type: 'string' },
          },
        },
      ],
    },
    inspo_reference: { type: ['string', 'null'] },
    swap_option: { type: ['string', 'null'] },
    missing_piece_suggestion: { type: ['string', 'null'] },
  },
}

// Keep the closet compact - ids + what matters for styling. Item-level wear stats help rotation.
const closet = (input.closet || []).map((i) => ({
  id: i.id, category: i.category, piece: i.sub_category,
  color: [i.primary_color, i.secondary_color].filter(Boolean).join(' / '),
  fabric: i.fabric, silhouette: i.silhouette, tags: i.aesthetic_tags, versatility: i.versatility_score,
  brand: [i.brand, i.product_name].filter(Boolean).join(' ') || null,
  last_worn: i.last_worn, times_worn: i.wear_count, desc: i.detailed_desc,
}))

const userText = `Event: ${input.event_context}
Today: ${new Date().toISOString().slice(0, 10)}

Client profile: ${JSON.stringify(input.profile)}

Closet (${closet.length} available items): ${JSON.stringify(closet)}

Inspo board (most recent first): ${JSON.stringify(input.inspo || [])}

Recent wear log with ratings (last 30 days): ${JSON.stringify(input.recent_wears || [])}

Build the outfit.`

const body = {
  model: MODEL,
  max_tokens: 8000,
  system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: userText }],
  output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
  fallbacks: 'default',
}
return [{ json: { ...input, body } }]
```

### n8n Code node: "Validate + format fit" (after Parse Claude)

```js
// Rejects hallucinated ids, enforces the Rule of the Anchor, formats the Telegram reply (with a /worn line).
const r = $input.first().json.result
const ctx = $('Build fit request').first().json
const closet = ctx.closet || []
const byId = new Map(closet.map((i) => [i.id, i]))
const text_ = (i) => `${i.sub_category || ''} ${i.silhouette || ''}`.toLowerCase()
const tags = (i) => i.aesthetic_tags || []
const isWide = (i) => tags(i).includes('wide-leg') || /\b(wide|baggy|barrel|loose|palazzo)\b/.test(text_(i))
const hasVolume = (i) => tags(i).includes('chunky') ||
  (!tags(i).includes('low-profile') && /\b(boot|lug|chunky|platform|derby|runner|990|salomon)\b/.test(text_(i)) &&
   !/\b(slim|low[- ]profile|flat|sleek|ballet|plimsoll|espadrille|slipper|driving)\b/.test(text_(i)))

const slots = ['top', 'bottom', 'footwear', 'statement']
const invalid = slots.map((s) => r.outfit[s].item_id).filter((id) => id && !byId.has(id))
if (invalid.length) throw new Error(`Claude returned unknown item ids: ${invalid.join(', ')} - re-run`)

// Rule of the Anchor: wide/baggy bottom => footwear with volume. Check Claude's self-report AND the closet data.
const bottom = byId.get(r.outfit.bottom.item_id)
const shoe = byId.get(r.outfit.footwear.item_id)
const wide = r.anchor_check.bottom_is_wide || (bottom && isWide(bottom))
let anchorNote = null
if (wide && (!shoe || !hasVolume(shoe) || !r.anchor_check.footwear_has_volume)) {
  const anchors = closet.filter((i) => i.category === 'footwear' && hasVolume(i))
    .sort((a, b) => (b.versatility_score || 0) - (a.versatility_score || 0) || String(a.last_worn || '').localeCompare(String(b.last_worn || '')))
  if (anchors.length) {
    r.outfit.footwear = { item_id: anchors[0].id, why: 'Swapped in to anchor the wide leg - it has the volume to catch the hem.' }
    anchorNote = `⚓ Shoe swapped to ${anchors[0].primary_color} ${anchors[0].sub_category}: wide legs need footwear with volume.`
  } else if (shoe || r.outfit.footwear.item_id) {
    r.outfit.footwear = { item_id: null, why: 'None of your shoes has the volume to anchor a wide leg.' }
    anchorNote = '⚓ No anchor shoe in your closet - a Camion-style high-shaft boot or chunky lug-sole derby is your #1 buy.'
  }
}

const lines = []
const ids = []
for (const s of slots) {
  const pick = r.outfit[s]
  const item = pick.item_id ? byId.get(pick.item_id) : null
  if (item) ids.push(item.id)
  const label = item ? `${item.primary_color} ${item.sub_category}` : '— nothing suitable in closet'
  lines.push(`• ${s[0].toUpperCase() + s.slice(1)}: ${label}\n   ${pick.why}`)
}

const pc = r.partner_coordination
const text = [
  `🧥 ${r.look_name}  (formality ${r.event_read.formality}/5)`,
  r.event_read.summary,
  '',
  ...lines,
  anchorNote ? `\n${anchorNote}` : '',
  r.anchor_check.hem_note ? `\n📏 Hem: ${r.anchor_check.hem_note}` : '',
  '',
  'How to wear it:',
  ...r.styling_instructions.map((x) => `– ${x}`),
  '',
  r.why_it_works_for_you,
  pc ? `\n💞 With your partner${pc.assumed ? ' (assumed look)' : ''}: ${pc.partner_likely_look}\nColour echo: ${pc.color_echo}\nBalance: ${pc.silhouette_balance}` : '',
  r.inspo_reference ? `\n✨ From your inspo: ${r.inspo_reference}` : '',
  r.swap_option ? `🔁 Swap: ${r.swap_option}` : '',
  r.missing_piece_suggestion ? `🛍 Worth buying: ${r.missing_piece_suggestion}` : '',
  ids.length ? `\nWearing it? Send:\n/worn ${ids.join(' ')}` : '',
].filter((x) => x !== '').join('\n')

return [{ json: { chat_id: ctx.chat_id, text: text.slice(0, 4000), item_ids: ids, anchor_enforced: !!anchorNote } }]
```

---

## D. Closet rework audit (`prompts/closet_audit.md`): `/audit`

**Workflow:** Webhook (`wardrobe-audit`) → Telegram "Auditing your closet, ~1 min…" → load context (SQL above) → **Build audit request** → HTTP → Parse Claude → INSERT into `closet_audits` → format → Telegram (several messages; Telegram's limit is 4096 characters each). Style Vault's **My Style** tab shows the latest audit's direction and shopping list.

```text
{{AUDIT_TEXT}}
```

### n8n Code node: "Build audit request"

```js
// Input: payload (focus, chat_id, ...) + context-query row (profile, closet, inspo, recent_wears)
const MODEL = 'claude-sonnet-5-5'   // or 'claude-opus-5-5' for a deeper audit
const STYLE_BRIEF = {{STYLE_BRIEF_JS}}

const input = $input.first().json
const SYSTEM = {{AUDIT_SYSTEM_JS}}

const uuid = { type: 'string', format: 'uuid' }
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['style_direction', 'verdicts', 'shopping_list', 'outfit_formulas', 'quick_wins'],
  properties: {
    style_direction: { type: 'string' },
    verdicts: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['item_id', 'verdict', 'reason', 'action'],
        properties: {
          item_id: uuid,
          verdict: { type: 'string', enum: ['keep', 'tailor', 'restyle', 'purge'] },
          reason: { type: 'string' },
          action: { type: ['string', 'null'] },
        },
      },
    },
    shopping_list: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['rank', 'piece', 'why', 'colors', 'fit_notes', 'budget_tier', 'pairs_with_item_ids'],
        properties: {
          rank: { type: 'integer' },
          piece: { type: 'string' },
          why: { type: 'string' },
          colors: { type: 'array', items: { type: 'string' } },
          fit_notes: { type: 'string' },
          budget_tier: { type: 'string', enum: ['save', 'mid', 'invest'] },
          pairs_with_item_ids: { type: 'array', items: uuid },
        },
      },
    },
    outfit_formulas: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['name', 'occasion', 'item_ids', 'how_to_wear'],
        properties: {
          name: { type: 'string' },
          occasion: { type: 'string' },
          item_ids: { type: 'array', items: uuid },
          how_to_wear: { type: 'string' },
        },
      },
    },
    quick_wins: { type: 'array', items: { type: 'string' } },
  },
}

const closet = (input.closet || []).map((i) => ({
  id: i.id, category: i.category, piece: i.sub_category,
  color: [i.primary_color, i.secondary_color].filter(Boolean).join(' / '),
  fabric: i.fabric, silhouette: i.silhouette, tags: i.aesthetic_tags, versatility: i.versatility_score,
  brand: [i.brand, i.product_name].filter(Boolean).join(' ') || null,
  times_worn: i.wear_count, last_worn: i.last_worn, desc: i.detailed_desc,
}))

const userText = `Client profile: ${JSON.stringify(input.profile)}

Closet (${closet.length} items, with wear stats): ${JSON.stringify(closet)}

Inspo board: ${JSON.stringify(input.inspo || [])}

Recent wear log with ratings: ${JSON.stringify(input.recent_wears || [])}
${input.focus ? `\nThe client asked to focus on: ${input.focus}` : ''}

Run the full closet audit.`

const body = {
  model: MODEL,
  max_tokens: 16000,
  system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: userText }],
  output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
  fallbacks: 'default',
}
return [{ json: { ...input, body } }]
```

### After the answer
- Validate ids like in C (drop or flag any id not in the closet).
- `INSERT INTO closet_audits (focus, style_direction, item_verdicts, shopping_list, outfit_formulas, raw_response) VALUES (...)`.
- Send 4 Telegram messages: **Direction**, **Verdicts** (grouped keep / tailor / restyle / purge, by item name), **Shopping list** (ranked), **Formulas** (each with a `/worn …` line).

---

## `/worn` and `/purge` workflows (no Claude call)

```sql
-- wardrobe-worn
INSERT INTO wear_logs (item_ids, worn_date, event_context, feedback_rating, feedback_notes)
VALUES ($1::uuid[], $2::date, NULL, $3, $4)
RETURNING id;
```
Parameters: `item_ids`, `worn_date`, `feedback_rating` (1–10 or null), `feedback_notes`. A database trigger updates each item's `wear_count` and `last_worn` and rejects unknown ids. On that error, reply "One of those ids isn't in your closet."

```sql
-- wardrobe-purge, mode = 'mark'
UPDATE items SET status = 'purged' WHERE id = ANY($1::uuid[]) RETURNING sub_category;
-- wardrobe-purge, mode = 'suggest': the purge verdicts from the latest audit
SELECT v->>'item_id' AS item_id, v->>'reason' AS reason, i.primary_color, i.sub_category
  FROM (SELECT item_verdicts FROM closet_audits ORDER BY created_at DESC LIMIT 1) a,
       jsonb_array_elements(a.item_verdicts) v
  JOIN items i ON i.id = (v->>'item_id')::uuid
 WHERE v->>'verdict' = 'purge' AND i.status = 'active';
```
