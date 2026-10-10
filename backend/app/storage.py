import uuid
from functools import lru_cache

import boto3
from botocore.config import Config

from .config import get_settings

# Validate by magic bytes, not the client-supplied content type.
_SIGNATURES = [
    (b"\xff\xd8\xff", "image/jpeg", "jpg"),
    (b"\x89PNG\r\n\x1a\n", "image/png", "png"),
    (b"GIF8", "image/gif", "gif"),
]


def sniff_image(data: bytes) -> tuple[str, str] | None:
    for sig, mime, ext in _SIGNATURES:
        if data.startswith(sig):
            return mime, ext
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp", "webp"
    return None


@lru_cache
def _client():
    s = get_settings()
    return boto3.client(
        "s3",
        endpoint_url=s.s3_endpoint_url or None,
        region_name=s.s3_region,
        aws_access_key_id=s.s3_access_key,
        aws_secret_access_key=s.s3_secret_key,
        config=Config(signature_version="s3v4", s3={"addressing_style": "virtual" if not s.s3_endpoint_url else "auto"}),
    )


def upload_image(data: bytes, mime: str, ext: str) -> str:
    """Blocking; call via run_in_threadpool. Returns the public URL."""
    s = get_settings()
    key = f"outfits/{uuid.uuid4().hex}.{ext}"
    _client().put_object(
        Bucket=s.s3_bucket, Key=key, Body=data, ContentType=mime,
        ACL="public-read", CacheControl="public, max-age=31536000, immutable",
    )
    if s.s3_public_base_url:
        return f"{s.s3_public_base_url.rstrip('/')}/{key}"
    if s.s3_endpoint_url:
        return f"{s.s3_endpoint_url.rstrip('/')}/{s.s3_bucket}/{key}"
    return f"https://{s.s3_bucket}.s3.{s.s3_region}.amazonaws.com/{key}"
