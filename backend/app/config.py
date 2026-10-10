from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

_REPO = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Shared wardrobe database (schema: wardrobe-bot/schema.sql)
    database_url: str = "postgresql://wardrobe:wardrobe@localhost:5432/wardrobe"
    api_port: int = 8000
    api_key: str = ""  # optional extra X-API-Key check; normally the web proxy's password protects the API
    cors_origins: str = "http://localhost:5173"

    # Media storage: "local" (files on this machine, served at /media) or "s3"
    storage_backend: str = "local"
    media_root: str = "/data/media"
    s3_endpoint_url: str = ""
    s3_region: str = "us-east-1"
    s3_bucket: str = ""
    s3_access_key: str = ""
    s3_secret_key: str = ""
    s3_public_base_url: str = ""
    max_image_mb: int = 15
    max_video_mb: int = 150
    store_videos: bool = True

    # Claude analysis
    anthropic_api_key: str = ""
    analysis_model: str = "claude-sonnet-5-5"
    analysis_frames: int = 6
    prompts_dir: str = str(_REPO / "wardrobe-bot" / "prompts")

    # Telegram: Style Vault replies to bot uploads when analysis finishes
    telegram_bot_token: str = ""
    telegram_api_base: str = "https://api.telegram.org"
    bot_shared_secret: str = ""  # bot -> Style Vault (and n8n) calls carry X-Bot-Secret
    public_url: str = ""  # e.g. https://style.example.com - used for "open in Style Vault" links

    # Drop tracker
    scraper_interval_minutes: int = 30
    scraper_use_playwright: bool = False
    scraper_timeout_seconds: int = 20


@lru_cache
def get_settings() -> Settings:
    return Settings()
