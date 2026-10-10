import asyncio
import json
import logging
import secrets
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware

from . import storage
from .config import get_settings
from .db import close_pool, init_pool, pool
from .schemas import CheckRequest, CheckResult, DropCreate, DropOut, OutfitUpdate
from .scraper import ScrapeError, assert_public_url
from .tracker import check_drops, periodic_loop

logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(_: FastAPI):
    await init_pool()
    task = asyncio.create_task(periodic_loop())
    yield
    task.cancel()
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

@app.post("/api/upload", dependencies=api, status_code=201)
async def upload(
    file: UploadFile = File(...),
    aesthetic_tags: str = Form(""),  # comma separated
    original_source_url: str = Form(""),
    clothing_items: str = Form("[]"),  # JSON array
):
    s = get_settings()
    if not s.s3_bucket:
        raise HTTPException(503, "S3 storage is not configured")
    data = await file.read(s.max_upload_mb * 1024 * 1024 + 1)
    if len(data) > s.max_upload_mb * 1024 * 1024:
        raise HTTPException(413, f"File exceeds {s.max_upload_mb}MB")
    kind = storage.sniff_image(data)
    if not kind:
        raise HTTPException(415, "Unsupported image type (use JPEG, PNG, GIF or WebP)")
    try:
        items = json.loads(clothing_items or "[]")
        if not isinstance(items, list):
            raise ValueError
    except ValueError:
        raise HTTPException(422, "clothing_items must be a JSON array")
    try:
        url = await run_in_threadpool(storage.upload_image, data, *kind)
    except Exception as e:
        logging.exception("S3 upload failed")
        raise HTTPException(502, "Storage upload failed") from e
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            "INSERT INTO outfits (image_url, original_source_url, aesthetic_tags, clothing_items) "
            "VALUES ($1, NULLIF($2,''), $3, $4) RETURNING *",
            url, original_source_url, _clean_tags(aesthetic_tags.split(",")), items,
        )
    return dict(row)


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
