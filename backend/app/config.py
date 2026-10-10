from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql://vault:vault@localhost:5432/vault"
    api_port: int = 8000
    api_key: str = ""  # if set, every /api request must send X-API-Key
    cors_origins: str = "http://localhost:5173"

    s3_endpoint_url: str = ""  # e.g. https://nyc3.digitaloceanspaces.com ; empty = AWS S3
    s3_region: str = "us-east-1"
    s3_bucket: str = ""
    s3_access_key: str = ""
    s3_secret_key: str = ""
    s3_public_base_url: str = ""  # e.g. https://my-bucket.nyc3.cdn.digitaloceanspaces.com
    max_upload_mb: int = 10

    scraper_interval_minutes: int = 30  # 0 disables the periodic loop
    scraper_use_playwright: bool = False
    scraper_timeout_seconds: int = 20


@lru_cache
def get_settings() -> Settings:
    return Settings()
