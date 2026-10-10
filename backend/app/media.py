"""Getting media onto local disk (upload or link) and turning it into frames for analysis."""
import asyncio
import json
import shutil
import tempfile
from pathlib import Path
from urllib.parse import urlparse

import httpx

from .config import get_settings
from .scraper import UA, ScrapeError, assert_public_url

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp"}


class MediaError(Exception):
    pass


def sniff(head: bytes) -> tuple[str, str, str] | None:
    """(media_type, mime, ext) from magic bytes - never trust the client's content type."""
    if head.startswith(b"\xff\xd8\xff"):
        return "image", "image/jpeg", "jpg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image", "image/png", "png"
    if head.startswith(b"GIF8"):
        return "image", "image/gif", "gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image", "image/webp", "webp"
    if head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand.startswith(b"qt"):
            return "video", "video/quicktime", "mov"
        return "video", "video/mp4", "mp4"
    if head.startswith(b"\x1a\x45\xdf\xa3"):
        return "video", "video/webm", "webm"
    return None


def new_workdir() -> Path:
    return Path(tempfile.mkdtemp(prefix="vault-"))


def cleanup(workdir: Path) -> None:
    shutil.rmtree(workdir, ignore_errors=True)


async def _run(*cmd: str, timeout: int) -> str:
    proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise MediaError(f"{cmd[0]} timed out")
    if proc.returncode != 0:
        raise MediaError(f"{cmd[0]} failed: {err.decode(errors='replace').strip().splitlines()[-1:] or ''}")
    return out.decode(errors="replace")


async def _download_direct(url: str, dest: Path, max_bytes: int) -> Path:
    async with httpx.AsyncClient(timeout=60, follow_redirects=False, headers={"User-Agent": UA}) as client:
        for _ in range(6):
            await assert_public_url(url)
            async with client.stream("GET", url) as r:
                if r.is_redirect:
                    url = str(r.url.join(r.headers.get("location", "")))
                    continue
                if r.status_code >= 400:
                    raise MediaError(f"Download failed: HTTP {r.status_code}")
                size = 0
                with dest.open("wb") as f:
                    async for chunk in r.aiter_bytes():
                        size += len(chunk)
                        if size > max_bytes:
                            raise MediaError("File too large")
                        f.write(chunk)
                return dest
    raise MediaError("Too many redirects")


async def download_link(url: str, workdir: Path) -> tuple[Path, str | None]:
    """TikTok / Instagram / Pinterest / YouTube etc. via yt-dlp; direct image/video links via httpx.
    Returns (file, caption) - the post caption often names brands, which helps identification."""
    s = get_settings()
    try:
        await assert_public_url(url)
    except ScrapeError as e:
        raise MediaError(str(e))
    max_bytes = s.max_video_mb * 1024 * 1024
    if Path(urlparse(url).path).suffix.lower() in IMAGE_EXTS | {".mp4", ".mov", ".webm"}:
        return await _download_direct(url, workdir / "source", max_bytes), None
    await _run(
        "yt-dlp", "--no-playlist", "--no-progress", "--quiet", "--no-warnings",
        "--max-filesize", f"{s.max_video_mb}M",
        "-f", "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080]/bv*+ba/b",
        "--merge-output-format", "mp4", "--write-info-json",
        "-o", str(workdir / "source.%(ext)s"),
        url,
        timeout=300,
    )
    files = [p for p in workdir.glob("source.*") if not p.name.endswith((".part", ".json"))]
    if not files:
        raise MediaError("Nothing was downloaded (private post, or unsupported link?)")
    caption = None
    info = workdir / "source.info.json"
    if info.exists():
        meta = json.loads(info.read_text())
        caption = "\n".join(x for x in (meta.get("title"), meta.get("description"), meta.get("uploader")) if x) or None
    return files[0], caption


async def probe_duration(path: Path) -> float:
    out = await _run("ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path), timeout=30)
    try:
        return float(json.loads(out)["format"]["duration"])
    except (KeyError, ValueError, TypeError):
        return 0.0


async def extract_frames(path: Path, media_type: str, workdir: Path, count: int) -> list[Path]:
    """Evenly spaced JPEG frames (max 1024px). An image yields a single normalised frame."""
    scale = "scale='min(1024,iw)':'min(1024,ih)':force_original_aspect_ratio=decrease"
    if media_type == "image":
        out = workdir / "frame_0.jpg"
        await _run("ffmpeg", "-y", "-v", "error", "-i", str(path), "-frames:v", "1", "-vf", scale, "-q:v", "3", str(out), timeout=60)
        return [out]
    duration = await probe_duration(path)
    if duration <= 0:
        raise MediaError("Could not read video duration")
    frames = []
    for i in range(count):
        t = duration * (i + 0.5) / count
        out = workdir / f"frame_{i}.jpg"
        await _run("ffmpeg", "-y", "-v", "error", "-ss", f"{t:.2f}", "-i", str(path),
                   "-frames:v", "1", "-vf", scale, "-q:v", "3", str(out), timeout=60)
        if out.exists() and out.stat().st_size:
            frames.append(out)
    if not frames:
        raise MediaError("Could not extract frames from video")
    return frames
