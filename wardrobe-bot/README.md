# Wardrobe Stylist Bot

The Telegram side of the wardrobe system: your daily driver and wear logger. It shares one PostgreSQL database with **Style Vault** (the visual dashboard and inspo scraper). Setup for the whole system is in the [root README](../README.md); this page covers the bot and the n8n workflows.

| File | What it is |
|---|---|
| `schema.sql` / `seed.sql` | **The** database for both apps: `items`, `user_profile`, `wear_logs`, `inspo`, `closet_audits`, `ingest_jobs`, `drops`. Idempotent, and upgrades older databases. |
| `prompts/*.md` | The Claude prompts, shared by Style Vault and n8n (see `prompts.md`). |
| `prompts.md` | Generated guide with copy-paste n8n Code nodes: `npm run build:prompts`. |
| `server.js` | Telegram webhook receiver. |
| `scripts/set-webhook.js` | Registers the webhook and command menu with Telegram (`setup.sh` runs it). |
| `test/` | `npm test`: the bot against fake Telegram/receivers, every n8n Code node, and checks that `prompts.md` and the aesthetic stay in sync. |

## Routing

| You send | `server.js` forwards to | Who answers |
|---|---|---|
| a photo, video, or image/video file | Style Vault `/api/bot/ingest` | Style Vault: "⏳ Analysing…", then "👕 Added 2 pieces…" |
| a photo/video captioned `inspo`, a pasted link, or `/inspo <link>` | Style Vault `/api/bot/inspo` | Style Vault: breakdown, formula, what you own, what's missing |
| `/fit <event>` | n8n `wardrobe-fit` | n8n |
| `/worn <ids> [8/10] [notes]` | n8n `wardrobe-worn` | n8n |
| `/purge` / `/purge <ids>` | n8n `wardrobe-purge` | n8n |
| `/audit [focus]` | n8n `wardrobe-audit` | n8n |

Every forwarded call carries `X-Bot-Secret: $BOT_SHARED_SECRET`. The bot serves nobody until `ALLOWED_CHAT_IDS` is set; message it and it replies with your chat ID.

## The four n8n workflows

All four start with a **Webhook** node: method POST, path as below, Authentication = Header Auth (`X-Bot-Secret` = your `BOT_SHARED_SECRET`), Respond = *Immediately*. Reply with **Telegram → Send Message** using `chat_id` from the payload. Credentials: **Postgres** (host `host.docker.internal` if n8n runs on the Mac, or `db` if it's the bundled one; database/user `wardrobe`), **Telegram** (bot token), **Header Auth "Anthropic"** (`x-api-key`).

| Path | Nodes |
|---|---|
| `wardrobe-fit` | Webhook → Postgres (context SQL) → Merge → **Build fit request** → HTTP (Claude) → **Parse Claude** → **Validate + format fit** → Telegram |
| `wardrobe-worn` | Webhook → Postgres INSERT `wear_logs` (On Error: continue) → Telegram "Logged ✅" / "One of those ids isn't in your closet" |
| `wardrobe-purge` | Webhook → IF `mode = mark` → UPDATE items → reply; else → purge verdicts from the latest audit → reply |
| `wardrobe-audit` | Webhook → Telegram "Auditing… ~1 min" → context SQL → **Build audit request** → HTTP → Parse → INSERT `closet_audits` → format → Telegram (several messages) |

The exact Code nodes and SQL are in [`prompts.md`](prompts.md). Photo and inspo analysis need no n8n workflow; Style Vault does it.

## Usage

- **Build your closet:** send photos or short try-on videos of what you own (or upload them in Style Vault). Flat lays with several pieces are split into several items.
- **Save inspo:** paste TikTok/IG/Pinterest links into the chat. Each one is broken down and mapped onto your closet.
- **Daily:** `/fit office, 12°C, rainy` → wear it → send the `/worn …` line it gives you, with a rating.
- **Dates:** `/fit dinner date, she's in a cream knit dress and gold jewellery`. The stylist complements, never matches: one subtle colour echo, balanced silhouettes.
- **Monthly:** `/audit`. Do the alterations first (hem breaks!), then buy from the top of the shopping list. Style Vault's **My Style** tab keeps the latest direction and list.

## Changing the aesthetic
Edit `prompts/style_brief.md` (currently Streetwear Tailoring after Dean The Mean and Chris Heyn: silhouette and drape over logos). Then:
1. `npm run build:prompts` and paste the updated *Build fit request* / *Build audit request* Code nodes into n8n.
2. `docker compose up -d --build api`, so Style Vault's analysis picks it up.

`npm test` fails if `prompts.md` is out of date.

## Cost
With `claude-sonnet-5-5`: about 1–3¢ per photo, 2–6¢ per video or link (6 frames), 2–5¢ per `/fit`, and 10–25¢ per `/audit` of a 100-item closet.
