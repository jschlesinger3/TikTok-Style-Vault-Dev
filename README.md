# Wardrobe System: Style Vault + Telegram Stylist

One system, two front ends, one database:

- **Style Vault** (web app): your visual closet dashboard and inspo scraper. Browse and edit your closet, save TikToks/Reels/Pins as inspo, edit your profile, see wear stats and your shopping list.
- **Telegram bot**: your daily driver. Send photos, videos or links; ask `/fit` for an outfit; log what you wore with `/worn`; run `/audit` to rework the closet.

```
              Cloudflare Tunnel (HTTPS)
                       │
                 web  :8080  (Caddy)
          ┌────────────┼──────────────────────────┐
  /telegram/webhook    │ password-protected        │
          │            ▼                           │
         bot ──▶  api (Style Vault) ──▶ Claude     │
          │       analysis queue, dashboard API    │
          │            │                           │
          └──▶ n8n ────┴──▶  PostgreSQL  ◀─────────┘
        /fit /worn /purge /audit   (items, user_profile, wear_logs, inspo, closet_audits, ingest_jobs, drops)
```

| Where | Path |
|---|---|
| Shared database schema + seed (single source of truth) | `wardrobe-bot/schema.sql`, `wardrobe-bot/seed.sql` |
| Claude prompts (shared by Style Vault and n8n) | `wardrobe-bot/prompts/*.md`; n8n copy-paste guide: `wardrobe-bot/prompts.md` |
| Style Vault backend (FastAPI) | `backend/app/` |
| Style Vault frontend (React + Tailwind, installable PWA) | `frontend/` |
| Telegram webhook receiver | `wardrobe-bot/server.js` |
| Web front door (Caddy) | `deploy/` |
| Everything together | `docker-compose.yml`, `.env.example`, `setup.sh` |

## How things flow

| You… | What happens | Lands in |
|---|---|---|
| send the bot a photo/video, or upload under **My closet** | Style Vault stores it, pulls video frames, Claude catalogues every piece (category, colours, fabric *and weight*, silhouette, brand only if visible, versatility for you) | `items` |
| paste a TikTok/IG/Pinterest link in Telegram, send a photo captioned `inspo`, or add under **Inspo** | the post is downloaded (yt-dlp), Claude breaks the look down, maps it onto your own pieces and lists what's missing | `inspo` |
| `/fit dinner date, she's in a black slip dress` | n8n loads profile + closet + inspo + recent wears, Claude builds a 4-piece outfit (with couple coordination for dates) | reply in Telegram |
| `/worn <ids> 8/10` in Telegram, or **Log an outfit** in Closet | wear log; a trigger updates each piece's wear count and last worn | `wear_logs` |
| `/audit` | keep / tailor / restyle / purge for every piece, ranked shopping list, outfit formulas | `closet_audits` → **My Style** tab |

Telegram uploads show up live in Style Vault's job strip, and the bot replies when analysis finishes, with an "Open in Style Vault" link.

## Aesthetic

Defined once in `wardrobe-bot/prompts/style_brief.md` and used by every prompt: **Streetwear Tailoring**, after Dean The Mean (@deanthemean) and Chris Heyn. **Silhouette and drape over logos**:
- **Top:** clean and structured (boxy vintage crewnecks, tailored work jackets, quarter-zips, muted knits, minimal hoodies).
- **Bottom:** heavy, wide and well-draped (baggy vintage denim, wide-leg tailored trousers, double-knee work pants).
- **Shoes:** substantial (chunky loafers, lug-sole derbies, archival runners, boots).

Recommendations talk fabric weight, hem break and silhouette contrast, never brand status. Dates follow a **couple-coordination** rule: complement your partner with one subtle colour echo and balanced silhouettes, never matching. Edit the brief or your profile (Style Vault → **My Style**) to tune it.

## Set up on the Mac Mini

**You need:** Docker Desktop or OrbStack, a Cloudflare Tunnel with a public hostname (e.g. `style.yourdomain.com`), a Claude API key, and a Telegram bot token from @BotFather.

1. **Tunnel:** in Cloudflare Zero Trust → Networks → Tunnels, add a public hostname pointing to `http://localhost:8080` if cloudflared runs on the Mac, or `http://web:80` if you let compose run it.
2. **Run setup:**
   ```bash
   git clone -b claude/tiktok-style-vault-fullstack-z37yj7 https://github.com/jschlesinger3/TikTok-Style-Vault-Dev.git
   cd TikTok-Style-Vault-Dev
   ./setup.sh
   ```
   It asks for a login, your Claude key, the Telegram token, the public URL, and whether cloudflared and n8n already run on the Mac. It then generates the secrets, writes `.env`, runs `docker compose up -d --build`, and registers the Telegram webhook.
3. **Unlock the bot:** message it once. It replies with your chat ID; re-run `./setup.sh` and enter it.
4. **n8n:** build the four conversation workflows (fit, worn, purge, audit). See [`wardrobe-bot/README.md`](wardrobe-bot/README.md) and [`wardrobe-bot/prompts.md`](wardrobe-bot/prompts.md). n8n reaches Postgres at `host.docker.internal:5432` (n8n outside compose) or `db:5432` (inside), database and user `wardrobe`.

Manual alternative: `cp .env.example .env`, fill it in, then `docker compose up -d --build`. Optional services are turned on with `COMPOSE_PROFILES` in `.env`: `tunnel` runs cloudflared in compose, `n8n` runs a bundled n8n.

**Day to day:** `docker compose logs -f api bot` · update with `git pull && docker compose up -d --build` · back up with `docker compose exec -T db pg_dump -U wardrobe wardrobe > backup.sql` (media lives in the `wardrobe_media` volume).

### Notes
- **Storage:** photos and videos are kept on the Mac (`STORAGE_BACKEND=local`) and served at `/media` behind the same password. Set `STORAGE_BACKEND=s3` plus the `S3_*` settings to use a bucket instead.
- **Upload limit:** Cloudflare's free plan caps request bodies at 100 MB, so `MAX_VIDEO_MB` defaults to 95. Telegram bots can only download files up to 20 MB; for longer clips, send the link instead.
- **Security:** only `/telegram/webhook` is public without the password, and the bot verifies Telegram's secret token on it. The bot → Style Vault endpoints (`/api/bot/*`) are blocked at the proxy and need `BOT_SHARED_SECRET`. Postgres, n8n and the web port listen on localhost only. Telegram file URLs (which contain the bot token) are never stored.
- **Existing database:** `wardrobe-bot/schema.sql` is idempotent and also upgrades older versions; `setup.sh` re-applies it on every run.
- **Phone:** open your URL, log in once, and Add to Home Screen. On Android, Style Vault then appears in the Share menu.

## Local development
```bash
# Postgres with the schema, then:
cd backend && pip install -r requirements.txt && DATABASE_URL=… MEDIA_ROOT=./media uvicorn app.main:app --reload
cd frontend && npm install && npm run dev          # http://localhost:5173, proxies /api to :8000
cd wardrobe-bot && npm install && npm test         # bot + prompt tests
```
