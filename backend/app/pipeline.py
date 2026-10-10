"""Analysis queue: media (upload / link / Telegram) -> stored -> frames -> Claude -> items or inspo rows.

Every job is an ingest_jobs row, so the dashboard can show progress and restarts can resume.
Closet jobs create rows in `items`; inspo jobs create one row in `inspo`. Telegram jobs get a reply.
"""
import asyncio
import logging
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

from fastapi.concurrency import run_in_threadpool

from . import media, storage, telegram
from .analyzer import analyze_closet, analyze_inspo
from .config import get_settings
from .db import pool

log = logging.getLogger("pipeline")


@dataclass
class Job:
    id: UUID
    local_path: Path | None = None  # fresh upload already on disk
    workdir: Path | None = None
    fetch_url: str | None = None  # where to download from (never stored: Telegram URLs contain the bot token)


_queue: asyncio.Queue[Job] = asyncio.Queue()


def enqueue(job: Job) -> None:
    _queue.put_nowait(job)


def _scrub(text: str) -> str:
    token = get_settings().telegram_bot_token
    return text.replace(token, "<bot-token>") if token else text


async def _update(job_id: UUID, **fields) -> None:
    sets = ", ".join(f"{k} = ${i}" for i, k in enumerate(fields, start=2))
    async with pool().acquire() as conn:
        await conn.execute(f"UPDATE ingest_jobs SET {sets} WHERE id = $1", job_id, *fields.values())


async def _acquire_media(job: Job, row, workdir: Path) -> tuple[Path, str | None]:
    """Returns (file, caption pulled from the post)."""
    if job.local_path:
        return job.local_path, None
    stored = row["video_url"] or row["media_url"]
    if stored:  # retry of a job whose media we already kept
        local = storage.local_file(stored)
        if local:
            return local, None
        path, _ = await media.download_link(stored, workdir)
        return path, None
    url = job.fetch_url or row["source_url"]
    if not url:
        raise media.MediaError("The original file is no longer available - please send it again")
    return await media.download_link(url, workdir)


async def process(job: Job) -> None:
    s = get_settings()
    workdir = job.workdir or media.new_workdir()
    row = None
    try:
        async with pool().acquire() as conn:
            row = await conn.fetchrow(
                "UPDATE ingest_jobs SET status='processing', error=NULL WHERE id=$1 RETURNING *", job.id)
        if row is None:
            return  # dismissed while queued

        path, caption = await _acquire_media(job, row, workdir)
        if caption and not row["caption"]:
            await _update(job.id, caption=caption[:4000])
        with path.open("rb") as f:
            kind = media.sniff(f.read(16))
        if not kind:
            raise media.MediaError("Unsupported media (send a JPEG/PNG/GIF/WebP photo or an MP4/MOV/WebM video)")
        media_type, mime, ext = kind
        frames = await media.extract_frames(path, media_type, workdir, s.analysis_frames)

        media_url, video_url = row["media_url"], row["video_url"]
        if not media_url:
            if media_type == "video":
                if s.store_videos:
                    video_url = await run_in_threadpool(storage.store, path, mime, ext)
                media_url = await run_in_threadpool(storage.store, frames[len(frames) // 2], "image/jpeg", "jpg")
            else:
                media_url = await run_in_threadpool(storage.store, path, mime, ext)
            await _update(job.id, media_url=media_url, video_url=video_url, media_type=media_type)

        async with pool().acquire() as conn:
            profile = await conn.fetchrow("SELECT * FROM user_profile WHERE id = 1")
        profile = {k: v for k, v in dict(profile).items() if k != "id"} if profile else None
        caption = caption or row["caption"]

        if row["kind"] == "closet":
            reply = await _closet(job.id, row, frames, media_type, profile, caption, media_url, video_url)
        else:
            reply = await _inspo(job.id, row, frames, media_type, profile, caption, media_url, video_url)
        log.info("job %s done (%s)", job.id, row["kind"])
        if row["telegram_chat_id"]:
            await telegram.send_message(row["telegram_chat_id"], reply, row["telegram_message_id"])
    except Exception as e:
        log.exception("job %s failed", job.id)
        msg = str(e) if isinstance(e, (media.MediaError, RuntimeError)) else f"{type(e).__name__}: {e}"
        msg = _scrub(msg)[:500]
        await _update(job.id, status="failed", error=msg)
        if row is not None and row["telegram_chat_id"]:
            await telegram.send_message(row["telegram_chat_id"], f"⚠️ Couldn't analyse that: {msg}", row["telegram_message_id"])
    finally:
        media.cleanup(workdir)


async def _closet(job_id, row, frames, media_type, profile, caption, media_url, video_url) -> str:
    a = await analyze_closet(frames, media_type, profile, row["notes"], caption)
    if not a.is_clothing or not a.items:
        raise RuntimeError(a.rejection_reason or "No clothing found in that image")
    ids = []
    async with pool().acquire() as conn, conn.transaction():
        for p in a.items:
            item_id = await conn.fetchval(
                """INSERT INTO items (image_url, video_url, category, sub_category, primary_color, secondary_color,
                                      fabric, silhouette, aesthetic_tags, detailed_desc, versatility_score,
                                      brand, product_name, source_job_id)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id""",
                media_url, video_url, p.category, p.sub_category, p.primary_color, p.secondary_color, p.fabric,
                p.silhouette, _tags(p.aesthetic_tags), p.detailed_desc, p.versatility_score, p.brand,
                p.product_name, job_id,
            )
            ids.append(item_id)
        await conn.execute(
            "UPDATE ingest_jobs SET status='done', result_item_ids=$2, finished_at=now() WHERE id=$1", job_id, ids)
    lines = [f"• {p.primary_color} {p.sub_category}" + (f" ({p.brand})" if p.brand else "")
             + f" — {p.versatility_score}/10" for p in a.items]
    n = len(a.items)
    return f"👕 Added {n} piece{'s' if n != 1 else ''} to your closet:\n" + "\n".join(lines) + _link("closet")


async def _inspo(job_id, row, frames, media_type, profile, caption, media_url, video_url) -> str:
    async with pool().acquire() as conn:
        closet = [dict(r) for r in await conn.fetch("SELECT * FROM closet_available")]
    a = await analyze_inspo(frames, media_type, profile, closet, row["notes"], caption)
    if not a.is_outfit:
        raise RuntimeError(a.notes or "That doesn't look like an outfit")
    known = {str(i["id"]): i for i in closet}
    recreate = []
    for r in a.recreate_with:  # never trust ids we didn't send
        item_id = str(r.item_id) if r.item_id and str(r.item_id) in known else None
        recreate.append({"piece": r.piece, "item_id": item_id, "how_close": r.how_close if item_id else "none"})
    async with pool().acquire() as conn, conn.transaction():
        inspo_id = await conn.fetchval(
            """INSERT INTO inspo (image_url, video_url, source_url, user_notes, caption, look_summary, why_it_works,
                                  formula, key_pieces, aesthetic_tags, palette, fit_for_user, recreate_with,
                                  missing_pieces, source_job_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id""",
            media_url, video_url, row["source_url"], row["notes"], caption, a.look_summary, a.why_it_works,
            a.formula, [p.model_dump() for p in a.key_pieces], _tags(a.aesthetic_tags), a.palette, a.fit_for_user,
            recreate, a.missing_pieces, job_id,
        )
        await conn.execute(
            "UPDATE ingest_jobs SET status='done', result_inspo_id=$2, finished_at=now() WHERE id=$1", job_id, inspo_id)
    owned = [f"{known[r['item_id']]['primary_color']} {known[r['item_id']]['sub_category']}"
             for r in recreate if r["item_id"]]
    parts = [f"✨ Saved to your inspo board\n{a.look_summary}", f"Formula: {a.formula}"]
    if owned:
        parts.append("From your closet: " + ", ".join(owned))
    if a.missing_pieces:
        parts.append("Missing: " + "; ".join(a.missing_pieces[:3]))
    return "\n\n".join(parts) + _link("inspo")


def _tags(tags: list[str]) -> list[str]:
    return list(dict.fromkeys(t.strip().lower().lstrip("#")[:40] for t in tags if t.strip()))


def _link(tab: str) -> str:
    url = get_settings().public_url
    return f"\n\nOpen in Style Vault: {url.rstrip('/')}/?tab={tab}" if url else ""


async def worker() -> None:
    # One job at a time: ffmpeg + yt-dlp are CPU/bandwidth heavy.
    while True:
        job = await _queue.get()
        try:
            await process(job)
        finally:
            _queue.task_done()


async def recover_interrupted() -> None:
    """The queue lives in memory; after a restart, re-queue unfinished jobs (they resume from stored media
    or the source link; Telegram/upload jobs that never got stored fail with a clear message)."""
    async with pool().acquire() as conn:
        rows = await conn.fetch("SELECT id FROM ingest_jobs WHERE status IN ('pending','processing') ORDER BY created_at")
    for r in rows:
        enqueue(Job(r["id"]))

