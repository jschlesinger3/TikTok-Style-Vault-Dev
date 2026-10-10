"""Loads the shared prompt files (wardrobe-bot/prompts/*.md) so Style Vault and the n8n workflows
use the same Style Brief and system prompts."""
import json
from functools import lru_cache
from pathlib import Path

from .config import get_settings


@lru_cache
def _read(name: str) -> str:
    path = Path(get_settings().prompts_dir) / f"{name}.md"
    return path.read_text(encoding="utf-8").strip()


def system_prompt(name: str, profile: dict | None) -> str:
    return (
        _read(name)
        .replace("{STYLE_BRIEF}", _read("style_brief"))
        .replace("{PROFILE_JSON}", json.dumps(profile or {}, default=str))
    )
