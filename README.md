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

Defined once in `wardrobe-bot/prompts/style_brief.md` and used by every prompt: **Streetwear Tailoring**, after Dean The Mean (@deanthemean) and Chris Heyn. "Tuff" and elevated: **silhouette and drape over logos**.
- **Camion / wide-leg geometry:** wide-leg heavyweight wool trousers (COS / Acne Studios shape) over high-shaft structured boots (Our Legacy Camion shape).
- **Rule of the Anchor (enforced in code):** a wide or baggy leg is never paired with a slim or low-profile shoe. The n8n Validate node swaps in a shoe with volume, or tells you to buy one, and **My Style** warns when you have no anchor shoe.
- **Uniform Loophole:** the wide-leg heavyweight tailored trouser is the foundation. It passes as slacks for dress codes and drapes like streetwear downtown.
- **Top:** clean and structured (boxy vintage crewnecks, tailored work jackets, quarter-zips, muted knits, minimal hoodies).
- **Bottom:** heavy, wide and well-draped (baggy vintage denim, wide-leg tailored trousers, double-knee work pants).
- **Shoes:** substantial (chunky loafers, lug-sole derbies, archival runners, boots).

Recommendations talk fabric weight, hem break and silhouette contrast, never brand status. Dates follow a **couple-coordination** rule: complement your partner with one subtle colour echo and balanced silhouettes, never matching. Edit the brief or your profile (Style Vault → **My Style**) to tune it.

## Set up on the Mac Mini (style.kalmankatse.bid)

### Why Docker for this, with n8n staying on npm
Style Vault isn't a Node app: it's Python (FastAPI) plus ffmpeg, yt-dlp, PostgreSQL and Caddy. Running that natively means a Homebrew Python venv, a Postgres service, ffmpeg and a process manager to keep alive, and macOS updates can break the venv. With Docker it's one `docker compose up -d`, versions are pinned, nothing touches the Mac's own Python or Postgres, and `restart: unless-stopped` brings everything back after a reboot.

**n8n stays exactly as you run it now (npm).** The bot reaches it at `host.docker.internal:5678`, and n8n reaches the database at `localhost`.

For a headless Mac Mini, [Colima](https://github.com/abiosoft/colima) is the lightest Docker runtime and runs without anyone logged in:
```bash
brew install colima docker docker-compose
mkdir -p ~/.docker/cli-plugins && ln -sfn "$(brew --prefix)/opt/docker-compose/bin/docker-compose" ~/.docker/cli-plugins/docker-compose
colima start --cpu 4 --memory 6 && brew services start colima      # starts at boot
```
(Docker Desktop or OrbStack also work, but Docker Desktop needs a logged-in user and "Start at login".)

### Steps
1. **Tunnel route:** your existing Cloudflare Tunnel needs one more public hostname: **`style.kalmankatse.bid` → `http://localhost:8080`**.
   - Dashboard-managed tunnel: Zero Trust → Networks → Tunnels → your tunnel → Public Hostname → Add.
   - Config-file tunnel (`~/.cloudflared/config.yml`): add it above the catch-all rule, then restart cloudflared.
     ```yaml
     ingress:
       - hostname: style.kalmankatse.bid
         service: http://localhost:8080
       # …your existing rules (e.g. n8n)…
       - service: http_status:404
     ```
   n8n does **not** need to be exposed for this. The bot talks to it locally.
2. **Run setup:**
   ```bash
   git clone -b claude/tiktok-style-vault-fullstack-z37yj7 https://github.com/jschlesinger3/TikTok-Style-Vault-Dev.git
   cd TikTok-Style-Vault-Dev
   ./setup.sh
   ```
   Answer "yes" to *cloudflared already running* and *n8n already running*. It asks for a login, your Claude key and the Telegram token. It defaults the address to `https://style.kalmankatse.bid`, generates the secrets, moves the database to port 5433 if something already uses 5432, writes `.env`, runs `docker compose up -d --build`, and registers the Telegram webhook.
3. **Unlock the bot:** message it once. It replies with your chat ID; re-run `./setup.sh` and enter it.
4. **n8n (npm):** build the four conversation workflows (fit, worn, purge, audit). See [`wardrobe-bot/README.md`](wardrobe-bot/README.md) and [`wardrobe-bot/prompts.md`](wardrobe-bot/prompts.md).
   - Postgres credential: host `localhost`, port = `DB_PORT` in `.env`, database and user `wardrobe`, password = `POSTGRES_PASSWORD` in `.env`.
   - Webhook auth: Header Auth `X-Bot-Secret` = `BOT_SHARED_SECRET` in `.env`.

Manual alternative: `cp .env.example .env`, fill it in, then `docker compose up -d --build`. Optional services are turned on with `COMPOSE_PROFILES` in `.env`: `tunnel` runs cloudflared in compose, `n8n` runs a bundled n8n. You need neither.

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
