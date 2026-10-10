# Style Vault

Send it TikToks, Reels, Pinterest pins, outfit photos or product pics. It downloads the media, pulls frames out of videos, has Claude identify every piece (category, colour, material, fit, brand/model when there's real evidence), and builds a searchable catalog of your style with shopping links for each piece. Plus a drop tracker for creator/brand collections.

React/Tailwind frontend · FastAPI backend · PostgreSQL · S3-compatible storage · Claude vision · yt-dlp + ffmpeg.

## How a video becomes catalog entries
1. **In**: upload photos/videos (multi-select) or paste a link (`/api/ingest/link`). Links go through **yt-dlp** (TikTok, Instagram, Pinterest, YouTube Shorts, …); the post caption is kept because it often names brands.
2. **Store**: the original goes to your bucket (videos stay playable in the vault) and a cover frame is saved.
3. **Frames**: ffmpeg samples `ANALYSIS_FRAMES` evenly spaced frames (≤1024px).
4. **Identify**: the frames + caption go to Claude in one request with a strict JSON schema. It merges duplicate sightings across frames and only names a brand when there's evidence (logo, caption, signature design) — the evidence and a confidence level are stored with the piece.
5. **Shop**: each piece gets Google Shopping / Google Lens / Depop / eBay links built from its search query.
6. **My Style** tab: every piece across your vault, grouped ("in 4 looks"), filterable by category, searchable, with your top aesthetics, colours and brands.

Processing is a background queue in the API process (one job at a time, so a small VM isn't overwhelmed); the UI shows live status and polls until done. Failed items get a Retry button, and anything interrupted by a restart is re-queued automatically.

**Cost**: with the default `claude-opus-5-5`, one 6-frame video is roughly a few cents. Lower `ANALYSIS_FRAMES` or set `ANALYSIS_MODEL=claude-sonnet-5-5` to spend less.

**Limits, honestly**: brand/model identification is only as good as what's visible — unbranded basics get a precise description + search query rather than a brand. Private posts, and sites that block datacenter IPs, may fail to download (Instagram in particular sometimes needs cookies); upload the file directly instead. Respect platform terms for anything you download.

```
setup.sh            one-command install on a server
frontend/           Vite + React + Tailwind (dark mode), installable PWA with Android share target
backend/            FastAPI (main, pipeline, media, analyzer, scraper, tracker, storage) + Dockerfile
deploy/             Caddy config + web image (HTTPS, password, serves the app)
db/init.sql         PostgreSQL DDL (outfits, drops) - idempotent
docker-compose.yml  web + api + postgres
```

## Set it up (one command)

You need: a small Ubuntu server (DigitalOcean/Linode/Lightsail, ~$12/mo, 2 GB RAM), a storage bucket with an access key (DigitalOcean Spaces / Linode Object Storage, ~$5/mo), and a Claude API key from console.anthropic.com. In your cloud firewall, allow ports 22, 80 and 443.

SSH into the server and run:
```bash
git clone -b claude/tiktok-style-vault-fullstack-z37yj7 https://github.com/jschlesinger3/TikTok-Style-Vault-Dev.git
cd TikTok-Style-Vault-Dev
./setup.sh
```
It installs Docker if needed, asks for a username/password and your keys, and prints your app's address, e.g. `https://203-0-113-7.sslip.io` (a free address based on your server IP; you can use your own domain instead). HTTPS certificates are automatic. Re-run `./setup.sh` any time to change settings; press Enter to keep each current value.

What runs: `web` (Caddy: HTTPS + password + the React app + `/api` proxy) → `api` (FastAPI + analysis queue) → `db` (Postgres). Only ports 80/443 are public.

**Updating later:** `git pull && docker compose up -d --build`.
**Logs:** `docker compose logs -f api` (or `web`, `db`).
**Backups:** your media is in the bucket; back up the database with `docker compose exec -T db pg_dump -U vault vault > vault-backup.sql`.

## Phone

Open your app address on your phone and log in once (the browser remembers it).

**Android (Chrome):** menu ⋮ → *Add to Home screen* / *Install app*. Style Vault then shows up in the **Share** menu: in TikTok tap Share → *Style Vault* (you may need "More" the first time). It works for links from TikTok/Instagram/Pinterest, and for photos/videos shared from your gallery. The app opens, adds it, and starts identifying the pieces.

**iPhone (Safari):** Share → *Add to Home Screen* for the app icon. iOS doesn't let web apps appear in the Share menu, so use a Shortcut to send links straight from TikTok:
1. On your server, get your login code: `printf 'USERNAME:PASSWORD' | base64` (use your real username and password).
2. Shortcuts app → **+** → tap the name → *Add to Style Vault*. Tap ⓘ → turn on **Show in Share Sheet**; set it to receive **URLs** and **Text**.
3. Add action **Get URLs from Input**.
4. Add action **Get Contents of URL**: URL `https://YOUR-ADDRESS/api/ingest/link`, Method **POST**, Headers: `Authorization` = `Basic <the code from step 1>`, Request Body **JSON** with one Text field `url` = *URLs* (the variable from step 3).
5. Add action **Show Notification** → "Added to Style Vault".

Now TikTok → Share → *Add to Style Vault*. (For photos/videos on iPhone, use the app's upload button, which can pick straight from Photos.)

## Manual / local development
```bash
cp .env.example .env               # fill in values
docker compose up -d --build db api
cd frontend && npm install && npm run dev   # http://localhost:5173, proxies /api to :8000
```
For a **managed** Postgres, run `psql "$DATABASE_URL" -f db/init.sql` and change the `DATABASE_URL` line under `api` in `docker-compose.yml`. Existing databases: re-run `db/init.sql` to add new columns (safe to repeat; `setup.sh` does this for you).

## API
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/upload` | multipart image **or video**: `file`, `aesthetic_tags` (csv), `original_source_url`, `clothing_items` (JSON array) → 202, analysed in background |
| POST | `/api/ingest/link` | `{url, aesthetic_tags}` — TikTok/IG/Pinterest/direct media link → 202 |
| POST | `/api/outfits/{id}/reanalyze` | re-run identification (keeps pieces you entered yourself) |
| GET | `/api/catalog` | all identified pieces (`?category=`) + style profile (top tags/colours/brands) |
| GET/PATCH/DELETE | `/api/outfits[/{id}]` | list (`?tag=`), edit tags/items, delete |
| GET | `/api/tags` | tags with counts |
| GET/POST/DELETE | `/api/drops[/{id}]` | manage tracked URLs |
| POST | `/api/tracker/check` | scrape now; returns `changes` + updated `drops` |

## Scraper notes
- Extraction order: JSON-LD `offers` → meta/microdata price → visible-text heuristics ("sold out", "coming soon", "add to cart"). These are heuristics; sites with unusual markup may report `unknown`. Enable Playwright for JS-rendered shops.
- A loop in the API process re-checks all drops every `SCRAPER_INTERVAL_MINUTES`. Run a single API replica (the loop is per-process). The UI polls every 30s, so changes found by the loop also trigger notifications.
- Target URLs are validated against private/internal addresses (SSRF guard), including on redirects.
- Respect each site's terms of service and robots.txt.
