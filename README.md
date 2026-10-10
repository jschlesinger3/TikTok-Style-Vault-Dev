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
frontend/   Vite + React + Tailwind (dark mode)
backend/    FastAPI app (app/main.py, scraper.py, tracker.py, storage.py) + Dockerfile
db/init.sql PostgreSQL DDL (outfits, drops)
docker-compose.yml  api + postgres
```

## Deploy the backend (any VM: DigitalOcean / Linode / Lightsail)
```bash
cp .env.example .env      # set POSTGRES_PASSWORD, S3_*, API_KEY, CORS_ORIGINS
docker compose up -d --build
curl localhost:8000/health
```
Schema is applied automatically on the first start. **Upgrading an existing database**: `docker compose exec -T db psql -U vault vault < db/init.sql` (safe to re-run; adds the new analysis columns). For a **managed** Postgres instead, run `psql "$DATABASE_URL" -f db/init.sql`, then run only the `api` service (`docker compose up -d --no-deps api`) with `DATABASE_URL` set in `.env` — but note compose overrides `DATABASE_URL` for `api`; edit that line in `docker-compose.yml` first.

Budget tip: a $6–12/mo VM + a $5/mo Spaces/Object Storage bucket covers this comfortably within $100.

## Frontend
```bash
cd frontend && cp .env.example .env && npm install
npm run dev      # proxies /api to localhost:8000
npm run build    # static files in dist/ — host on any static host or behind nginx/Caddy
```
For production set `VITE_API_URL` to the public API URL (put the API behind HTTPS, e.g. Caddy) and add the frontend origin to `CORS_ORIGINS`. `VITE_API_KEY` is embedded in the JS bundle, so it only deters casual access — put real auth in front for anything sensitive.

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
