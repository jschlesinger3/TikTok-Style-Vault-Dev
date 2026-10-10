# Style Vault

TikTok-style outfit vault + creator drop tracker. React/Tailwind frontend, FastAPI backend, PostgreSQL, S3-compatible storage.

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
Schema is applied automatically on the first start. For a **managed** Postgres instead, run `psql "$DATABASE_URL" -f db/init.sql`, then run only the `api` service (`docker compose up -d --no-deps api`) with `DATABASE_URL` set in `.env` — but note compose overrides `DATABASE_URL` for `api`; edit that line in `docker-compose.yml` first.

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
| POST | `/api/upload` | multipart: `file`, `aesthetic_tags` (csv), `original_source_url`, `clothing_items` (JSON array) → S3 + DB |
| GET/PATCH/DELETE | `/api/outfits[/{id}]` | list (`?tag=`), edit tags/items, delete |
| GET | `/api/tags` | tags with counts |
| GET/POST/DELETE | `/api/drops[/{id}]` | manage tracked URLs |
| POST | `/api/tracker/check` | scrape now; returns `changes` + updated `drops` |

## Scraper notes
- Extraction order: JSON-LD `offers` → meta/microdata price → visible-text heuristics ("sold out", "coming soon", "add to cart"). These are heuristics; sites with unusual markup may report `unknown`. Enable Playwright for JS-rendered shops.
- A loop in the API process re-checks all drops every `SCRAPER_INTERVAL_MINUTES`. Run a single API replica (the loop is per-process). The UI polls every 30s, so changes found by the loop also trigger notifications.
- Target URLs are validated against private/internal addresses (SSRF guard), including on redirects.
- Respect each site's terms of service and robots.txt.
