"""Style Vault API - the visual dashboard over the shared wardrobe database.

Reads/writes the same tables the Telegram bot and n8n use (items, user_profile, wear_logs, inspo,
closet_audits), runs the analysis queue for uploads, links and bot photos, and the drop tracker.
"""
import asyncio
import logging
import secrets
from contextlib import asynccontextmanager
from datetime import date
from typing import Any, Literal
from uuid import UUID

import asyncpg
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, HttpUrl

from . import media, telegram
from .analyzer import shopping_links
from .config import get_settings
from .db import close_pool, init_pool, pool
from .pipeline import Job, enqueue, recover_interrupted, worker
from .schemas import CheckRequest, CheckResult, DropCreate, DropOut
from .scraper import ScrapeError, assert_public_url
from .tracker import check_drops, periodic_loop

logging.basicConfig(level=logging.INFO)

Kind = Literal["closet", "inspo"]
ITEM_STATUSES = ("active", "laundry", "archived", "purged")


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


def require_bot_secret(x_bot_secret: str = Header(default="")):
    secret = get_settings().bot_shared_secret
    if not secret:
        raise HTTPException(503, "BOT_SHARED_SECRET is not configured")
    if not secrets.compare_digest(x_bot_secret, secret):
        raise HTTPException(401, "Invalid bot secret")


app = FastAPI(title="Style Vault API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in get_settings().cors_origins.split(",") if o.strip()],
    allow_methods=["*"],
    allow_headers=["*"],
)
api = [Depends(require_api_key)]

# Locally stored photos/videos (STORAGE_BACKEND=local). The web proxy puts these behind the same password.
if get_settings().storage_backend == "local":
    app.mount("/media", StaticFiles(directory=get_settings().media_root, check_dir=False), name="media")


@app.get("/health")
async def health():
    async with pool().acquire() as conn:
        await conn.fetchval("SELECT 1")
    return {"ok": True}


def _clean_tags(tags: list[str]) -> list[str]:
    return list(dict.fromkeys(t.strip().lower().lstrip("#")[:40] for t in tags if t and t.strip()))


# ======================================================================
# Ingestion (dashboard uploads + links, and bot photos/videos/links)
# ======================================================================

async def _create_job(kind: str, source: str, *, source_url=None, notes=None, chat_id=None, message_id=None) -> dict:
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            "INSERT INTO ingest_jobs (kind, source, source_url, notes, telegram_chat_id, telegram_message_id) "
            "VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
            kind, source, source_url, (notes or None) and notes[:2000], chat_id, message_id,
        )
    return dict(row)


@app.post("/api/upload", dependencies=api, status_code=202)
async def upload(
    file: UploadFile = File(...),
    kind: Kind = Form("closet"),
    notes: str = Form(""),
    source_url: str = Form(""),
):
    """A photo or video of something you own (kind=closet) or a look you like (kind=inspo)."""
    s = get_settings()
    workdir = media.new_workdir()
    try:
        head = await file.read(16)
        sniffed = media.sniff(head)
        if not sniffed:
            raise HTTPException(415, "Unsupported file (use JPEG/PNG/GIF/WebP images or MP4/MOV/WebM video)")
        limit_mb = s.max_video_mb if sniffed[0] == "video" else s.max_image_mb
        path = workdir / f"source.{sniffed[2]}"
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
    job = await _create_job(kind, "upload", source_url=source_url or None, notes=notes)
    enqueue(Job(job["id"], local_path=path, workdir=workdir))
    return job


class LinkIn(BaseModel):
    url: HttpUrl
    kind: Kind = "inspo"
    notes: str = ""


@app.post("/api/ingest/link", dependencies=api, status_code=202)
async def ingest_link(body: LinkIn):
    """TikTok / Instagram / Pinterest / YouTube Shorts link, or a direct image/video URL."""
    url = str(body.url)
    try:
        await assert_public_url(url)
    except ScrapeError as e:
        raise HTTPException(422, str(e))
    job = await _create_job(body.kind, "link", source_url=url, notes=body.notes)
    enqueue(Job(job["id"]))
    return job


class BotMedia(BaseModel):
    file_url: str
    file_id: str | None = None
    mime_type: str | None = None


class BotPayload(BaseModel):
    """What wardrobe-bot/server.js sends (same shape it sends to n8n)."""
    type: str
    chat_id: int
    message_id: int | None = None
    media: BotMedia | None = None
    caption: str | None = None
    notes: str | None = None
    source_url: str | None = None


async def _bot_job(kind: str, p: BotPayload) -> dict:
    s = get_settings()
    fetch_url = p.media.file_url if p.media else p.source_url
    if not fetch_url:
        raise HTTPException(422, "Nothing to analyse: send a photo, video or link")
    if p.media and not fetch_url.startswith(f"{s.telegram_api_base}/file/bot"):
        raise HTTPException(422, "media.file_url must be a Telegram file URL")
    notes = p.notes if kind == "inspo" else p.caption
    # Telegram file URLs embed the bot token, so only the public post link (if any) is stored.
    job = await _create_job(kind, "telegram", source_url=p.source_url, notes=notes,
                            chat_id=p.chat_id, message_id=p.message_id)
    enqueue(Job(job["id"], fetch_url=fetch_url))
    what = "your piece" if kind == "closet" else "that look"
    await telegram.send_message(p.chat_id, f"⏳ Analysing {what}…", p.message_id)
    return {"job_id": job["id"]}


@app.post("/api/bot/ingest", dependencies=[Depends(require_bot_secret)], status_code=202)
async def bot_ingest(p: BotPayload):
    return await _bot_job("closet", p)


@app.post("/api/bot/inspo", dependencies=[Depends(require_bot_secret)], status_code=202)
async def bot_inspo(p: BotPayload):
    return await _bot_job("inspo", p)


@app.get("/api/jobs", dependencies=api)
async def list_jobs():
    """Unfinished and recently failed jobs (finished ones show up as items / inspo)."""
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            "SELECT * FROM ingest_jobs WHERE status <> 'done' OR finished_at > now() - interval '30 seconds' "
            "ORDER BY created_at DESC LIMIT 50")
    return [dict(r) for r in rows]


@app.post("/api/jobs/{job_id}/retry", dependencies=api, status_code=202)
async def retry_job(job_id: UUID):
    async with pool().acquire() as conn:
        row = await conn.fetchrow(
            "UPDATE ingest_jobs SET status='pending', error=NULL WHERE id=$1 AND status='failed' RETURNING *", job_id)
    if not row:
        raise HTTPException(409, "Only failed jobs can be retried")
    enqueue(Job(job_id))
    return dict(row)


@app.delete("/api/jobs/{job_id}", dependencies=api, status_code=204)
async def dismiss_job(job_id: UUID):
    async with pool().acquire() as conn:
        await conn.execute("DELETE FROM ingest_jobs WHERE id=$1 AND status IN ('failed','done')", job_id)


# ======================================================================
# Closet (items)
# ======================================================================

@app.get("/api/items", dependencies=api)
async def list_items(
    status: str = Query("active"),  # active | laundry | archived | purged | all
    category: str | None = None,
    tag: str | None = None,
    q: str | None = None,
):
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            """SELECT * FROM items
               WHERE ($1 = 'all' OR status = $1)
                 AND ($2::text IS NULL OR category = $2)
                 AND ($3::text IS NULL OR $3 = ANY(aesthetic_tags))
                 AND ($4::text IS NULL OR concat_ws(' ', sub_category, primary_color, secondary_color, fabric,
                                                    silhouette, brand, product_name, detailed_desc) ILIKE '%' || $4 || '%')
               ORDER BY created_at DESC LIMIT 1000""",
            status, category, tag, (q or "").strip() or None,
        )
    return [dict(r) for r in rows]


class ItemUpdate(BaseModel):
    status: Literal["active", "laundry", "archived", "purged"] | None = None
    category: Literal["top", "bottom", "outerwear", "tailoring", "footwear", "accessory", "other"] | None = None
    sub_category: str | None = None
    primary_color: str | None = None
    secondary_color: str | None = None
    fabric: str | None = None
    silhouette: str | None = None
    aesthetic_tags: list[str] | None = None
    detailed_desc: str | None = None
    versatility_score: int | None = Field(None, ge=1, le=10)
    brand: str | None = None
    product_name: str | None = None


@app.patch("/api/items/{item_id}", dependencies=api)
async def update_item(item_id: UUID, body: ItemUpdate):
    fields = body.model_dump(exclude_unset=True)
    if "aesthetic_tags" in fields:
        fields["aesthetic_tags"] = _clean_tags(fields["aesthetic_tags"] or [])
    if not fields:
        raise HTTPException(422, "Nothing to update")
    # column names come from the pydantic model, never from user input
    sets = ", ".join(f"{k} = ${i}" for i, k in enumerate(fields, start=2))
    async with pool().acquire() as conn:
        row = await conn.fetchrow(f"UPDATE items SET {sets} WHERE id = $1 RETURNING *", item_id, *fields.values())
    if not row:
        raise HTTPException(404, "Item not found")
    return dict(row)


@app.delete("/api/items/{item_id}", dependencies=api, status_code=204)
async def delete_item(item_id: UUID):
    """Hard delete is for mis-detections only; anything you've worn should be purged/archived instead
    so your wear history stays intact."""
    async with pool().acquire() as conn:
        row = await conn.fetchrow("SELECT wear_count FROM items WHERE id = $1", item_id)
        if row is None:
            return
        if row["wear_count"] > 0 or await conn.fetchval(
                "SELECT EXISTS (SELECT 1 FROM wear_logs WHERE $1 = ANY(item_ids))", item_id):
            raise HTTPException(409, "This piece has wear history - mark it purged or archived instead")
        await conn.execute("DELETE FROM items WHERE id = $1", item_id)


@app.get("/api/tags", dependencies=api)
async def list_tags():
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            "SELECT t AS tag, count(*) AS count FROM items, unnest(aesthetic_tags) t WHERE status = 'active' "
            "GROUP BY t ORDER BY count DESC, t")
    return [dict(r) for r in rows]


# ======================================================================
# Inspo board
# ======================================================================

def _inspo_out(r) -> dict:
    d = dict(r)
    d["key_pieces"] = [{**p, "links": shopping_links(p.get("search_query") or p.get("piece", ""))}
                       for p in (d.get("key_pieces") or [])]
    d["missing_pieces"] = [{"piece": m, "links": shopping_links(m)} for m in (d.get("missing_pieces") or [])]
    return d


@app.get("/api/inspo", dependencies=api)
async def list_inspo(status: Literal["active", "archived", "all"] = "active"):
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            "SELECT * FROM inspo WHERE ($1 = 'all' OR status = $1) ORDER BY created_at DESC LIMIT 500", status)
        ids = {i["item_id"] for r in rows for i in (r["recreate_with"] or []) if i.get("item_id")}
        items = {str(i["id"]): dict(i) for i in await conn.fetch(
            "SELECT id, image_url, sub_category, primary_color, status FROM items WHERE id = ANY($1::uuid[])", list(ids))}
    out = []
    for r in rows:
        d = _inspo_out(r)
        d["recreate_with"] = [{**x, "item": items.get(x.get("item_id") or "")} for x in d["recreate_with"]]
        out.append(d)
    return out


class InspoUpdate(BaseModel):
    status: Literal["active", "archived"]


@app.patch("/api/inspo/{inspo_id}", dependencies=api)
async def update_inspo(inspo_id: UUID, body: InspoUpdate):
    async with pool().acquire() as conn:
        row = await conn.fetchrow("UPDATE inspo SET status=$2 WHERE id=$1 RETURNING *", inspo_id, body.status)
    if not row:
        raise HTTPException(404, "Inspo not found")
    return _inspo_out(row)


@app.delete("/api/inspo/{inspo_id}", dependencies=api, status_code=204)
async def delete_inspo(inspo_id: UUID):
    async with pool().acquire() as conn:
        await conn.execute("DELETE FROM inspo WHERE id=$1", inspo_id)


# ======================================================================
# Profile, wear log, overview
# ======================================================================

class Profile(BaseModel):
    skin_tone: str | None = None
    hair_color: str | None = None
    eye_color: str | None = None
    build: str | None = None
    target_aesthetics: list[str] = []
    color_rules: dict[str, Any] = {}


@app.get("/api/profile", dependencies=api)
async def get_profile():
    async with pool().acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM user_profile WHERE id = 1")
    return Profile(**{k: v for k, v in dict(row).items() if k != "id"}) if row else Profile()


@app.put("/api/profile", dependencies=api)
async def put_profile(p: Profile):
    async with pool().acquire() as conn:
        await conn.execute(
            """INSERT INTO user_profile (id, skin_tone, hair_color, eye_color, build, target_aesthetics, color_rules)
               VALUES (1, $1, $2, $3, $4, $5, $6)
               ON CONFLICT (id) DO UPDATE SET skin_tone=$1, hair_color=$2, eye_color=$3, build=$4,
                                              target_aesthetics=$5, color_rules=$6""",
            p.skin_tone, p.hair_color, p.eye_color, p.build, [t.strip() for t in p.target_aesthetics if t.strip()],
            p.color_rules,
        )
    return p


@app.get("/api/wear-logs", dependencies=api)
async def wear_logs(days: int = Query(60, ge=1, le=3650)):
    async with pool().acquire() as conn:
        logs = await conn.fetch(
            "SELECT * FROM wear_logs WHERE worn_date >= CURRENT_DATE - $1::int ORDER BY worn_date DESC, id LIMIT 200",
            days)
        ids = list({i for log in logs for i in log["item_ids"]})
        items = {i["id"]: dict(i) for i in await conn.fetch(
            "SELECT id, image_url, sub_category, primary_color, category FROM items WHERE id = ANY($1::uuid[])", ids)}
    return [{**dict(log), "items": [items[i] for i in log["item_ids"] if i in items]} for log in logs]


class WearIn(BaseModel):
    item_ids: list[UUID] = Field(min_length=1)
    worn_date: date | None = None
    event_context: str | None = None
    feedback_rating: int | None = Field(None, ge=1, le=10)
    feedback_notes: str | None = None


@app.post("/api/wear-logs", dependencies=api, status_code=201)
async def add_wear_log(w: WearIn):
    try:
        async with pool().acquire() as conn:
            row = await conn.fetchrow(
                "INSERT INTO wear_logs (item_ids, worn_date, event_context, feedback_rating, feedback_notes) "
                "VALUES ($1, coalesce($2, CURRENT_DATE), $3, $4, $5) RETURNING *",
                list(dict.fromkeys(w.item_ids)), w.worn_date, w.event_context, w.feedback_rating, w.feedback_notes)
    except asyncpg.ForeignKeyViolationError:
        raise HTTPException(422, "One of those items isn't in your closet")
    return dict(row)


@app.get("/api/overview", dependencies=api)
async def overview():
    """Everything the My Style page shows, in one round trip."""
    async with pool().acquire() as conn:
        stats = await conn.fetchrow(
            """SELECT
                 (SELECT count(*) FROM items WHERE status = 'active') AS active_items,
                 (SELECT count(*) FROM inspo WHERE status = 'active') AS inspo_count,
                 (SELECT count(*) FROM wear_logs WHERE worn_date >= CURRENT_DATE - 30) AS wears_30d,
                 (SELECT coalesce(jsonb_agg(x ORDER BY x.n DESC), '[]') FROM
                    (SELECT category, count(*) AS n FROM items WHERE status='active' GROUP BY category) x) AS categories,
                 (SELECT coalesce(jsonb_agg(x ORDER BY x.n DESC), '[]') FROM
                    (SELECT lower(primary_color) AS color, count(*) AS n FROM items WHERE status='active'
                     AND primary_color IS NOT NULL GROUP BY lower(primary_color) ORDER BY n DESC LIMIT 10) x) AS colors,
                 (SELECT coalesce(jsonb_agg(x ORDER BY x.n DESC), '[]') FROM
                    (SELECT t AS tag, count(*) AS n FROM items, unnest(aesthetic_tags) t WHERE status='active'
                     GROUP BY t ORDER BY n DESC LIMIT 10) x) AS tags""")
        most_worn = await conn.fetch(
            "SELECT id, image_url, sub_category, primary_color, wear_count, last_worn FROM items "
            "WHERE status='active' AND wear_count > 0 ORDER BY wear_count DESC, last_worn DESC LIMIT 6")
        never_worn = await conn.fetch(
            "SELECT id, image_url, sub_category, primary_color, versatility_score, created_at FROM items "
            "WHERE status='active' AND wear_count = 0 AND created_at < now() - interval '21 days' "
            "ORDER BY versatility_score NULLS FIRST, created_at LIMIT 12")
        audit = await conn.fetchrow(
            "SELECT created_at, style_direction, shopping_list FROM closet_audits ORDER BY created_at DESC LIMIT 1")
        wants = await conn.fetch(
            "SELECT m AS piece, count(*) AS n FROM inspo, jsonb_array_elements_text(missing_pieces) m "
            "WHERE status='active' GROUP BY m ORDER BY n DESC, max(created_at) DESC LIMIT 10")
    shopping = []
    if audit:
        shopping = [{**p, "source": "audit", "links": shopping_links(p.get("piece", ""))}
                    for p in (audit["shopping_list"] or [])]
    seen = {s["piece"].strip().lower() for s in shopping}  # the audit's entry wins over an inspo duplicate
    shopping += [{"piece": w["piece"], "why": f"Missing from {w['n']} saved look{'s' if w['n'] > 1 else ''}",
                  "source": "inspo", "links": shopping_links(w["piece"])}
                 for w in wants if w["piece"].strip().lower() not in seen]
    return {
        **dict(stats),
        "most_worn": [dict(r) for r in most_worn],
        "never_worn": [dict(r) for r in never_worn],
        "latest_audit": {"created_at": audit["created_at"], "style_direction": audit["style_direction"]} if audit else None,
        "shopping": shopping,
    }


# ======================================================================
# Drop Tracker
# ======================================================================

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
