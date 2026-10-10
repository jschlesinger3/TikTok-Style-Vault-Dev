"""Claude vision analyses. System prompts come from wardrobe-bot/prompts/ (shared with the n8n workflows)."""
import base64
from pathlib import Path
from typing import Literal, TypeVar
from urllib.parse import quote_plus
from uuid import UUID

import anthropic
from pydantic import BaseModel

from .config import get_settings
from .prompts import system_prompt

Category = Literal["top", "bottom", "outerwear", "tailoring", "footwear", "accessory", "other"]
Score = Literal[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]


# ---- closet item (matches the items table) ----

class ClosetPiece(BaseModel):
    category: Category
    sub_category: str
    primary_color: str
    secondary_color: str | None
    fabric: str
    silhouette: str
    aesthetic_tags: list[str]
    brand: str | None
    product_name: str | None
    detailed_desc: str
    versatility_score: Score


class ClosetAnalysis(BaseModel):
    is_clothing: bool
    rejection_reason: str | None
    items: list[ClosetPiece]


# ---- inspo look (matches the inspo table) ----

class InspoPiece(BaseModel):
    piece: str
    category: Category
    color: str
    role: Literal["anchor", "edge", "finisher", "base layer"]
    search_query: str


class Recreate(BaseModel):
    piece: str
    item_id: UUID | None
    how_close: Literal["exact", "close", "loose", "none"]


class InspoAnalysis(BaseModel):
    is_outfit: bool
    look_summary: str
    why_it_works: str
    formula: str
    key_pieces: list[InspoPiece]
    aesthetic_tags: list[str]
    palette: list[str]
    fit_for_user: str
    recreate_with: list[Recreate]
    missing_pieces: list[str]
    notes: str | None


T = TypeVar("T", bound=BaseModel)


def _image_block(path: Path) -> dict:
    data = base64.standard_b64encode(path.read_bytes()).decode()
    return {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": data}}


def _client() -> anthropic.AsyncAnthropic:
    return anthropic.AsyncAnthropic(api_key=get_settings().anthropic_api_key or None, max_retries=3)


async def _run(prompt: str, profile: dict | None, frames: list[Path], text: str, schema: type[T]) -> T:
    s = get_settings()
    response = await _client().beta.messages.parse(
        model=s.analysis_model,
        max_tokens=16000,
        system=[{"type": "text", "text": system_prompt(prompt, profile), "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": [*(_image_block(f) for f in frames), {"type": "text", "text": text}]}],
        output_format=schema,
        output_config={"effort": "medium"},
        # If the model declines, the API retries on a suitable fallback model within the same call.
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    )
    if response.stop_reason == "refusal":
        raise RuntimeError("The model declined to analyse this media")
    if response.parsed_output is None:
        raise RuntimeError(f"No structured output (stop_reason={response.stop_reason})")
    return response.parsed_output


def _intro(frames: list[Path], media_type: str, notes: str | None, caption: str | None) -> str:
    out = f"{len(frames)} frames from one video, in order." if media_type == "video" else "One photo."
    if caption:
        out += f"\nPost caption (may name brands): {caption[:1500]}"
    if notes:
        out += f"\nThe client's note: {notes[:1000]}"
    return out


async def analyze_closet(frames, media_type, profile, notes=None, caption=None) -> ClosetAnalysis:
    text = _intro(frames, media_type, notes, caption) + "\nCatalogue the pieces the client owns."
    return await _run("closet_item_vision", profile, frames, text, ClosetAnalysis)


async def analyze_inspo(frames, media_type, profile, closet: list[dict], notes=None, caption=None) -> InspoAnalysis:
    compact = [
        {"id": str(i["id"]), "category": i["category"], "piece": i["sub_category"],
         "color": " / ".join(c for c in (i["primary_color"], i["secondary_color"]) if c),
         "fabric": i["fabric"], "silhouette": i["silhouette"]}
        for i in closet
    ]
    text = (_intro(frames, media_type, notes, caption)
            + f"\nClient's closet (available items): {compact}\nBreak down this inspo look for the client.")
    return await _run("inspo_vision", profile, frames, text, InspoAnalysis)


def shopping_links(query: str, image_url: str | None = None) -> dict[str, str]:
    q = quote_plus(query)
    links = {
        "google_shopping": f"https://www.google.com/search?tbm=shop&q={q}",
        "depop": f"https://www.depop.com/search/?q={q}",
        "ebay": f"https://www.ebay.com/sch/i.html?_nkw={q}",
    }
    if image_url and image_url.startswith(("http://", "https://")):
        links["google_lens"] = f"https://lens.google.com/uploadbyurl?url={quote_plus(image_url)}"
    return links
