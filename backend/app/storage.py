"""Media storage: local disk (default - served by the web proxy at /media) or S3-compatible bucket."""
import shutil
import uuid
from functools import lru_cache
from pathlib import Path

from .config import get_settings

LOCAL_PREFIX = "/media/"


def store(path: Path, mime: str, ext: str) -> str:
    """Blocking; call via run_in_threadpool. Returns the URL to save in the database."""
    s = get_settings()
    key = f"{uuid.uuid4().hex[:2]}/{uuid.uuid4().hex}.{ext}"
    if s.storage_backend == "s3":
        _s3().upload_file(
            str(path), s.s3_bucket, key,
            ExtraArgs={"ContentType": mime, "ACL": "public-read", "CacheControl": "public, max-age=31536000, immutable"},
        )
        if s.s3_public_base_url:
            return f"{s.s3_public_base_url.rstrip('/')}/{key}"
        if s.s3_endpoint_url:
            return f"{s.s3_endpoint_url.rstrip('/')}/{s.s3_bucket}/{key}"
        return f"https://{s.s3_bucket}.s3.{s.s3_region}.amazonaws.com/{key}"
    dest = Path(s.media_root) / key
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(path, dest)
    return LOCAL_PREFIX + key


def local_file(url: str) -> Path | None:
    """The file on disk for a locally stored URL, if it is one."""
    if not url.startswith(LOCAL_PREFIX):
        return None
    root = Path(get_settings().media_root).resolve()
    p = (root / url[len(LOCAL_PREFIX):]).resolve()
    return p if p.is_relative_to(root) and p.is_file() else None


def is_public(url: str | None) -> bool:
    return bool(url) and url.startswith(("http://", "https://"))


@lru_cache
def _s3():
    import boto3
    from botocore.config import Config

    s = get_settings()
    return boto3.client(
        "s3", endpoint_url=s.s3_endpoint_url or None, region_name=s.s3_region,
        aws_access_key_id=s.s3_access_key, aws_secret_access_key=s.s3_secret_key,
        config=Config(signature_version="s3v4"),
    )
