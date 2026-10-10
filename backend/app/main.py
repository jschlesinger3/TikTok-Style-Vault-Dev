import asyncio
import json
import logging
import secrets
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from pydantic import BaseModel, HttpUrl

from . import media
from .config import get_settings
from .db import close_pool, init_pool, pool
from .schemas import CheckRequest, CheckResult, DropCreate, DropOut, OutfitUpdate
from .scraper import ScrapeError, assert_public_url
from .pipeline import Job, enqueue, recover_interrupted, worker
from .tracker import check_drops, periodic_loop

logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(_: FastAPI):
    await init_pool()
    tasks = [asyncio.create_task(periodic_loop()), asyncio.create_task(worker())]
    await recover_interrupted()
    yield
    for t in tasks:
        t.cancel()
    await close_pool()


def require_api_key(x_api_key: str = Header(default="")):
    key = get_settings().api_key
    if key and not secrets.compare_digest(x_api_key, key):
        raise HTTPException(401, "Invalid or missing API key")


app = FastAPI(title="Style Vault API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in get_settings().cors_origins.split(",") if o.strip()],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    async with pool().acquire() as conn:
        await conn.fetchval("SELECT 1")
    return {"ok": True}


api = [Depends(require_api_key)]


def _clean_tags(tags: list[str]) -> list[str]:
    seen: dict[str, None] = {}
    for t in tags:
        t = t.strip().lower().lstrip("#")
        if t:
            seen[t[:40]] = None
    return list(seen)


# ---------- Style Vault ----------

@app.post("/api/upload", dependencies=api, status_code=202)
async def upload(
    file: UploadFile = File(...),
    aesthetic_tags: str = Form(""),  # comma separated
    original_source_url: str = Form(""),
    clothing_items: str = Form("[]"),  # JSON array of {name, url?}
):
    """Photo or video of an outfit / item. Stored + analysed in the background; poll /api/outfits."""
    s = get_settings()
    if not s.s3_bucket:
        raise HTTPException(503, "S3 storage is not configured")
    items = _parse_items(clothing_items)
    workdir = media.new_workdir()
    try:
        head = await file.read(16)
        kind = media.sniff(head)
        if not kind:
            raise HTTPException(415, "Unsupported file (use JPEG/PNG/GIF/WebP images or MP4/MOV/WebM video)")
        limit_mb = s.max_video_mb if kind[0] == "video" else s.max_image_mb
        path = workdir / f"source.{kind[2]}"
        size = len(head)
        with path.open("wb") as f:
            f.write(head)
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > limit_mb * 1024 * 1024:
                    raise HTTPException(413, f"File exceeds {limit_mb}MB")
                f.write(chunk)
    except BaseException:
        media.cleanup(workdir)
        raise
    row = await _insert_pending(kind[0], original_source_url, aesthetic_tags, items)
    enqueue(Job(row["id"], local_path=path, workdir=workdir))
    return row


class LinkIn(BaseModel):
    url: HttpUrl
    aesthetic_tags: list[str] = []


@app.post("/api/ingest/link", dependencies=api, status_code=202)
async def ingest_link(body: LinkIn):
    """TikTok / Instagram / Pinterest / YouTube Shorts link, or a direct image/video URL."""
    if not get_settings().s3_bucket:
        raise HTTPException(503, "S3 storage is not configured")
    url = str(body.url)
    try:
        await assert_public_url(url)
    except ScrapeError as e:
        raise HTTPException(422, str(e))
    row = await _insert_pending("video", url, ",".join(body.aesthetic_tags), [])
    enqueue(Job(row["id"], link=url))
    return row


@app.post("/api/outfits/{outfit_id}/reanalyze", dependencies=api, status_code=202)
async def reanalyze(outfit_id: int):
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            "UPDATE outfits SET analysis_status='pending', analysis_error=NULL WHERE id=$1 "
            "AND analysis_status IN ('done','failed') RETURNING *", outfit_id)
    if not row:
        raise HTTPException(409, "Outfit not found or already being analysed")
    stored = row["video_url"] or row["image_url"]
    if stored:
        enqueue(Job(outfit_id, link=stored, already_stored=True))
    elif row["original_source_url"]:
        enqueue(Job(outfit_id, link=row["original_source_url"]))
    else:
        raise HTTPException(409, "No media to analyse - please re-upload")
    return dict(row)


def _parse_items(raw: str) -> list:
    try:
        items = json.loads(raw or "[]")
        if not isinstance(items, list):
            raise ValueError
    except ValueError:
        raise HTTPException(422, "clothing_items must be a JSON array")
    return [{**i, "source": "user"} for i in items if isinstance(i, dict)]


async def _insert_pending(media_type: str, source_url: str, tags_csv: str, items: list):
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            "INSERT INTO outfits (media_type, original_source_url, aesthetic_tags, clothing_items, analysis_status) "
            "VALUES ($1, NULLIF($2,''), $3, $4, 'pending') RETURNING *",
            media_type, source_url, _clean_tags(tags_csv.split(",")), items,
        )
    return dict(row)


@app.get("/api/catalog", dependencies=api)
async def catalog(category: str | None = Query(None)):
    """Every identified piece across the vault, flattened - your shopping reference."""
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            """SELECT o.id AS outfit_id, o.image_url, o.aesthetic_tags, o.date_added, item
               FROM outfits o, jsonb_array_elements(o.clothing_items) item
               WHERE ($1::text IS NULL OR item->>'category' = $1)
               ORDER BY o.date_added DESC""",
            category,
        )
        stats = await conn.fetchrow(
            """SELECT
                 (SELECT coalesce(jsonb_agg(x ORDER BY x.n DESC), '[]') FROM
                    (SELECT t AS tag, count(*) AS n FROM outfits, unnest(aesthetic_tags) t GROUP BY t ORDER BY n DESC LIMIT 12) x) AS top_tags,
                 (SELECT coalesce(jsonb_agg(x ORDER BY x.n DESC), '[]') FROM
                    (SELECT lower(c) AS color, count(*) AS n FROM outfits, unnest(color_palette) c GROUP BY lower(c) ORDER BY n DESC LIMIT 12) x) AS top_colors,
                 (SELECT coalesce(jsonb_agg(x ORDER BY x.n DESC), '[]') FROM
                    (SELECT i->>'brand' AS brand, count(*) AS n FROM outfits, jsonb_array_elements(clothing_items) i
                     WHERE coalesce(i->>'brand','') <> '' GROUP BY i->>'brand' ORDER BY n DESC LIMIT 12) x) AS top_brands,
                 (SELECT coalesce(jsonb_agg(x ORDER BY x.n DESC), '[]') FROM
                    (SELECT i->>'category' AS category, count(*) AS n FROM outfits, jsonb_array_elements(clothing_items) i
                     GROUP BY i->>'category' ORDER BY n DESC) x) AS categories"""
        )
    return {
        "items": [{**r["item"], "outfit_id": r["outfit_id"], "image_url": r["image_url"],
                   "aesthetic_tags": r["aesthetic_tags"], "date_added": r["date_added"]} for r in rows],
        "profile": dict(stats),
    }


@app.get("/api/outfits", dependencies=api)
async def list_outfits(tag: str | None = Query(None)):
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            "SELECT * FROM outfits WHERE ($1::text IS NULL OR $1 = ANY(aesthetic_tags)) ORDER BY date_added DESC LIMIT 500",
            tag,
        )
    return [dict(r) for r in rows]


@app.patch("/api/outfits/{outfit_id}", dependencies=api)
async def update_outfit(outfit_id: int, body: OutfitUpdate):
    fields = body.model_dump(exclude_unset=True)
    if "aesthetic_tags" in fields:
        fields["aesthetic_tags"] = _clean_tags(fields["aesthetic_tags"] or [])
    if not fields:
        raise HTTPException(422, "Nothing to update")
    # column names come from the pydantic model, never from user input
    sets = ", ".join(f"{k} = ${i}" for i, k in enumerate(fields, start=2))
    async with pool().acquire() as conn:
        row = await conn.fetchrow(f"UPDATE outfits SET {sets} WHERE id = $1 RETURNING *", outfit_id, *fields.values())
    if not row:
        raise HTTPException(404, "Outfit not found")
    return dict(row)


@app.delete("/api/outfits/{outfit_id}", dependencies=api, status_code=204)
async def delete_outfit(outfit_id: int):
    async with pool().acquire() as conn:
        await conn.execute("DELETE FROM outfits WHERE id = $1", outfit_id)


@app.get("/api/tags", dependencies=api)
async def list_tags():
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            "SELECT t AS tag, count(*) AS count FROM outfits, unnest(aesthetic_tags) t GROUP BY t ORDER BY count DESC, t"
        )
    return [dict(r) for r in rows]


# ---------- Drop Tracker ----------

@app.get("/api/drops", response_model=list[DropOut], dependencies=api)
async def list_drops():
    async with pool().acquire() as conn:
        return [dict(r) for r in await conn.fetch("SELECT * FROM drops ORDER BY drop_timestamp NULLS LAST, id")]


@app.post("/api/drops", response_model=DropOut, status_code=201, dependencies=api)
async def create_drop(body: DropCreate):
    url = str(body.target_url)
    try:
        await assert_public_url(url)
    except ScrapeError as e:
        raise HTTPException(422, str(e))
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            "INSERT INTO drops (creator_name, collection_title, target_url, drop_timestamp) VALUES ($1,$2,$3,$4) "
            "ON CONFLICT (target_url) DO NOTHING RETURNING *",
            body.creator_name, body.collection_title, url, body.drop_timestamp,
        )
    if not row:
        raise HTTPException(409, "That URL is already being tracked")
    return dict(row)


@app.delete("/api/drops/{drop_id}", dependencies=api, status_code=204)
async def delete_drop(drop_id: int):
    async with pool().acquire() as conn:
        await conn.execute("DELETE FROM drops WHERE id = $1", drop_id)


@app.post("/api/tracker/check", response_model=CheckResult, dependencies=api)
async def tracker_check(body: CheckRequest | None = None):
    """Scrape tracked URLs now. Returns only what changed so the UI can notify."""
    checked, changes = await check_drops(body.drop_ids if body else None)
    async with pool().acquire() as conn:
        drops = [dict(r) for r in await conn.fetch("SELECT * FROM drops ORDER BY drop_timestamp NULLS LAST, id")]
    return CheckResult(checked=checked, changes=changes, drops=drops)
