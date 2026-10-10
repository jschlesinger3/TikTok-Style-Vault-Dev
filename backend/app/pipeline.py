"""Background ingestion: fetch media -> store in S3 -> extract frames -> Claude analysis -> DB."""
import asyncio
import logging
from dataclasses import dataclass
from pathlib import Path

from fastapi.concurrency import run_in_threadpool

from . import media, storage
from .analyzer import analyze_frames, to_clothing_items
from .config import get_settings
from .db import pool

log = logging.getLogger("pipeline")


@dataclass
class Job:
    outfit_id: int
    local_path: Path | None = None  # fresh upload, already on disk in workdir
    workdir: Path | None = None
    link: str | None = None  # TikTok/IG/Pinterest/direct link, or our own stored media URL on re-analyse
    already_stored: bool = False


_queue: asyncio.Queue[Job] = asyncio.Queue()


def enqueue(job: Job) -> None:
    _queue.put_nowait(job)


async def _set(outfit_id: int, **fields) -> None:
    sets = ", ".join(f"{k} = ${i}" for i, k in enumerate(fields, start=2))
    async with pool().acquire() as conn:
        await conn.execute(f"UPDATE outfits SET {sets} WHERE id = $1", outfit_id, *fields.values())


async def process(job: Job) -> None:
    s = get_settings()
    workdir = job.workdir or media.new_workdir()
    try:
        await _set(job.outfit_id, analysis_status="processing", analysis_error=None)
        caption = None
        if job.local_path:
            path = job.local_path
        elif job.already_stored:
            path, _ = await media.download_link(job.link, workdir)
        else:
            path, caption = await media.download_link(job.link, workdir)
            if caption:
                await _set(job.outfit_id, caption=caption[:4000])
        with path.open("rb") as f:
            kind = media.sniff(f.read(16))
        if not kind:
            raise media.MediaError("Unsupported media type (use JPEG/PNG/GIF/WebP images or MP4/MOV/WebM video)")
        media_type, mime, ext = kind

        frames = await media.extract_frames(path, media_type, workdir, s.analysis_frames)

        async with pool().acquire() as conn:
            row = await conn.fetchrow("SELECT * FROM outfits WHERE id = $1", job.outfit_id)
        if row is None:
            return  # deleted while queued
        image_url, video_url = row["image_url"], row["video_url"]
        if not job.already_stored:
            if media_type == "video":
                if s.store_videos:
                    video_url = await run_in_threadpool(storage.upload_file, path, mime, ext)
                # cover image = middle frame
                image_url = await run_in_threadpool(storage.upload_file, frames[len(frames) // 2], "image/jpeg", "jpg")
            else:
                image_url = await run_in_threadpool(storage.upload_file, path, mime, ext)
            await _set(job.outfit_id, image_url=image_url, video_url=video_url, media_type=media_type)

        analysis = await analyze_frames(frames, media_type, row["caption"])

        user_items = [i for i in (row["clothing_items"] or []) if i.get("source") != "ai"]
        tags = list(dict.fromkeys([*row["aesthetic_tags"], *(t.strip().lower().lstrip("#") for t in analysis.aesthetic_tags)]))
        await _finish(
            job.outfit_id,
            user_items + to_clothing_items(analysis, image_url or None),
            [t[:40] for t in tags if t],
            analysis.summary,
            analysis.color_palette,
        )
        log.info("outfit %s analysed: %d pieces", job.outfit_id, len(analysis.pieces))
    except Exception as e:
        log.exception("outfit %s failed", job.outfit_id)
        msg = str(e) if isinstance(e, (media.MediaError, RuntimeError)) else f"{type(e).__name__}: {e}"
        await _set(job.outfit_id, analysis_status="failed", analysis_error=msg[:500])
    finally:
        media.cleanup(workdir)


async def _finish(outfit_id: int, items: list, tags: list, summary: str, palette: list) -> None:
    async with pool().acquire() as conn:
        await conn.execute(
            "UPDATE outfits SET clothing_items=$2, aesthetic_tags=$3, summary=$4, color_palette=$5, "
            "analysis_status='done', analysis_error=NULL, analyzed_at=now() WHERE id=$1",
            outfit_id, items, tags, summary, palette,
        )


async def worker() -> None:
    # Run jobs one at a time: ffmpeg + yt-dlp are CPU/bandwidth heavy on a small VM.
    while True:
        job = await _queue.get()
        try:
            await process(job)
        finally:
            _queue.task_done()


async def recover_interrupted() -> None:
    """Jobs live in memory, so after a restart re-queue anything unfinished that we can still reach."""
    async with pool().acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, image_url, video_url, original_source_url FROM outfits WHERE analysis_status IN ('pending','processing')"
        )
    for r in rows:
        stored = r["video_url"] or r["image_url"]
        if stored:
            enqueue(Job(r["id"], link=stored, already_stored=True))
        elif r["original_source_url"]:
            enqueue(Job(r["id"], link=r["original_source_url"]))
        else:
            await _set(r["id"], analysis_status="failed", analysis_error="Interrupted by a server restart - please re-upload")
