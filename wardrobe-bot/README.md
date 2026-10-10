# Wardrobe Stylist Bot

A personal stylist on Telegram. It knows your closet, your inspo, your build and colouring, and what you've worn, and it rebuilds your wardrobe toward **tough, not sloppy; polished, not stiff**: old-money tailoring as the backbone, streetwear and ballhog luxury as the edge.

```
Telegram ──HTTPS──▶ Caddy ──▶ server.js ──▶ n8n workflows ──▶ Claude (vision + styling)
                                               │
                                               └──▶ PostgreSQL (items, inspo, wear_logs, user_profile, closet_audits)
```

| File | What it is |
|---|---|
| `schema.sql` | Tables: `items`, `user_profile`, `wear_logs`, plus `inspo` and `closet_audits`. Includes a trigger that keeps wear counts updated, and the `closet_available` view. |
| `seed.sql` | Your profile: olive/warm undertone, dark hair, brown eyes, athletic V build, target aesthetics, and starter colour rules. |
| `server.js` | Telegram webhook receiver that forwards to n8n. |
| `prompts.md` | The four Claude prompts, plus copy-paste n8n Code nodes that build each request. |
| `docker-compose.yml` | Postgres, n8n, the bot and Caddy (HTTPS) on one VM. |
| `test/` | `npm test`: runs the bot against fake Telegram and n8n, and executes every Code node in `prompts.md`. |

## Using it

| You do | You get |
|---|---|
| Send a photo of something you own | It's catalogued: category, exact colours, fabric, silhouette, aesthetic, and a versatility score for *your* style. A flat lay with several pieces becomes several items. |
| Send a photo captioned `inspo` (or `/inspo <link> what I like`) | A breakdown of why the look works, its reusable formula, how to adapt it to your build, which of *your* pieces recreate it, and what's missing. |
| `/fit rooftop dinner, 18°C` | One 4-piece outfit from your closet (top, bottom, footwear, statement piece), with how to wear it, why it suits you, and a ready-made `/worn …` line. |
| `/worn <ids> 8/10 felt sharp` | Logs the outfit. Ratings teach the stylist what works for you, and it rotates away from what you just wore. |
| `/audit` (or `/audit shoes and outerwear`) | **The closet rework:** a keep / tailor / restyle / purge verdict on every item, a ranked shopping list of the pieces that bridge tough and polished, 5–8 go-to outfits from what you own, and quick wins for this week. |
| `/purge` / `/purge <ids>` | Purge suggestions from your latest audit / mark items as gone. |

### Reworking your closet: the plan
1. **Photograph everything you'd actually wear**, one piece or a flat lay per photo. Be honest; include the stuff you're unsure about.
2. **Save 10–20 inspo looks** you'd genuinely want to wear. This teaches the stylist your version of "tough but put together".
3. **Run `/audit`.** Do the tailoring list first; it's the cheapest upgrade. Then buy from the top of the shopping list, one or two pieces at a time.
4. **Use `/fit` for real days** and `/worn` with a rating. Re-run `/audit` monthly to see the wardrobe tighten up.

> **One thing to check:** I read "ballhog luxury" as *basketball-rooted luxury*: premium sneakers, elevated sweats and hoops references, statement outerwear, gold accents. If you mean something else, edit that line in the Style Brief (`prompts.md`) or add a `"ballhog_luxury"` definition to `color_rules` in `seed.sql`. The stylist follows whatever you write there.

## Setup (about 30 minutes)

**You need:** a small VM (2 GB RAM, ~$12/mo), a Telegram account, and an Anthropic API key.

1. **Create the bot:** message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
2. **On the server:**
   ```bash
   git clone -b claude/tiktok-style-vault-fullstack-z37yj7 https://github.com/jschlesinger3/TikTok-Style-Vault-Dev.git
   cd TikTok-Style-Vault-Dev/wardrobe-bot
   cp .env.example .env && nano .env      # token, secrets (openssl rand -hex 24), DOMAIN, POSTGRES_PASSWORD
   docker compose up -d --build
   npm install && npm run set-webhook      # or: docker compose exec bot node scripts/set-webhook.js
   ```
   No domain? Use `DOMAIN=<your-ip-with-dashes>.sslip.io`. Open ports 80/443 in your cloud firewall.
3. **Unlock it for you:** the bot answers nobody until it knows your chat ID. Message it anything, and it replies with your ID. Put that in `ALLOWED_CHAT_IDS`, then run `docker compose up -d bot`.
4. **Open n8n privately:** `ssh -L 5678:localhost:5678 you@server`, then browse to http://localhost:5678.
   - Add credentials: **Postgres** (host `db`, database/user `wardrobe`, your `POSTGRES_PASSWORD`), **Telegram** (bot token), **Header Auth "Anthropic"** (`x-api-key` = your API key), **Header Auth "Bot"** (`X-Bot-Secret` = your `N8N_SHARED_SECRET`).
5. **Build the six workflows** (next section) and activate them.
6. Send your bot a photo. 🎉

## n8n workflows

Every workflow starts with a **Webhook** node: method POST, path as below, Authentication = Header Auth "Bot", Respond = *Immediately*. Use `chat_id` from the payload in the final **Telegram → Send Message** node. Prompt details and Code nodes: `prompts.md`.

| Path | Nodes |
|---|---|
| `wardrobe-ingest` | Webhook → HTTP GET `photo.file_url` (as File) → Extract from File (to base64 `image_b64`) → Postgres (`SELECT to_jsonb(p) AS profile FROM user_profile p`) → Merge → **Build ingest request** → HTTP (Claude) → **Parse Claude** → IF `is_clothing` → Split Out `result.items` → Postgres INSERT → Aggregate → Telegram reply |
| `wardrobe-inspo` | Webhook → context SQL → IF photo → download + base64 → **Build inspo request** → HTTP → Parse → INSERT `inspo` → Telegram reply |
| `wardrobe-fit` | Webhook → context SQL → Merge → **Build fit request** → HTTP → Parse → **Validate + format fit** → Telegram reply |
| `wardrobe-worn` | Webhook → Postgres INSERT `wear_logs` (On Error: continue) → Telegram "Logged ✅" or "One of those ids isn't in your closet" |
| `wardrobe-audit` | Webhook → Telegram "Auditing… ~1 min" → context SQL → **Build audit request** → HTTP → Parse → INSERT `closet_audits` → Code (format 4 messages) → Telegram (one message per item) |
| `wardrobe-purge` | Webhook → IF `mode = mark` → UPDATE `items` SET status='purged' → reply; else → latest audit's purge verdicts → reply |

Tip: the bot shows items by name, but `/worn` needs ids. Every `/fit` reply ends with a ready-to-send `/worn <ids>` line, so you can just tap and send it.

## Cost
Using `claude-sonnet-5-5` ($2 / $10 per million input/output tokens): a photo is roughly 1–2¢, a `/fit` 2–5¢, and an `/audit` of a 100-item closet ~10–25¢. Swap `/audit` to `claude-opus-5-5` for deeper reasoning (about 2× the price).

## Security notes
- Telegram calls are verified with `TELEGRAM_WEBHOOK_SECRET`. Only chats in `ALLOWED_CHAT_IDS` get served, so no one else can spend your API credits.
- n8n is only reachable through the SSH tunnel. The bot → n8n calls stay inside Docker and carry `X-Bot-Secret`.
- Telegram file URLs contain your bot token. Don't send them to Claude (use base64) and don't store them; store `tg:<file_id>` instead.
