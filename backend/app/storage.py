import uuid
from functools import lru_cache
from pathlib import Path

import boto3
from botocore.config import Config

from .config import get_settings


@lru_cache
def _client():
    s = get_settings()
    return boto3.client(
        "s3",
        endpoint_url=s.s3_endpoint_url or None,
        region_name=s.s3_region,
        aws_access_key_id=s.s3_access_key,
        aws_secret_access_key=s.s3_secret_key,
        config=Config(signature_version="s3v4"),
    )


def public_url(key: str) -> str:
    s = get_settings()
    if s.s3_public_base_url:
        return f"{s.s3_public_base_url.rstrip('/')}/{key}"
    if s.s3_endpoint_url:
        return f"{s.s3_endpoint_url.rstrip('/')}/{s.s3_bucket}/{key}"
    return f"https://{s.s3_bucket}.s3.{s.s3_region}.amazonaws.com/{key}"


def upload_file(path: Path, mime: str, ext: str) -> str:
    """Blocking (streams from disk); call via run_in_threadpool. Returns the public URL."""
    key = f"media/{uuid.uuid4().hex}.{ext}"
    _client().upload_file(
        str(path), get_settings().s3_bucket, key,
        ExtraArgs={"ContentType": mime, "ACL": "public-read", "CacheControl": "public, max-age=31536000, immutable"},
    )
    return public_url(key)
