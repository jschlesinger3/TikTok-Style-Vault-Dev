"""Claude vision: identify garments, aesthetics and likely products from outfit frames."""
import base64
from pathlib import Path
from typing import Literal
from urllib.parse import quote_plus

import anthropic
from pydantic import BaseModel

from .config import get_settings

Category = Literal["top", "bottom", "dress", "outerwear", "shoes", "bag", "accessory", "jewelry", "headwear", "eyewear", "other"]


class Piece(BaseModel):
    name: str  # e.g. "cropped boxy denim jacket"
    category: Category
    color: str
    material: str | None
    pattern: str | None
    fit: str | None
    brand: str | None  # only when a logo, tag, caption or truly signature design makes it identifiable
    product_name: str | None  # specific model/product line if identifiable, e.g. "Samba OG"
    brand_confidence: Literal["none", "low", "medium", "high"]
    evidence: str | None  # what the brand guess is based on (logo, caption text, signature design)
    search_query: str  # best shopping search query to find this exact or a very close item


class StyleAnalysis(BaseModel):
    summary: str  # one or two sentences describing the look
    aesthetic_tags: list[str]  # lowercase, e.g. "y2k", "quiet luxury", "gorpcore", "coquette"
    color_palette: list[str]
    pieces: list[Piece]


SYSTEM = """You are a fashion stylist cataloguing a person's personal style so they can shop for it later.
You receive one photo, several frames from one short video (TikTok/Reels style), or a product photo.

List every distinct clothing item and accessory worn or shown. Frames from the same video show the same
outfit(s) - merge duplicates, and only list a separate outfit's pieces if the video clearly changes outfits.
Be specific and shoppable in names (silhouette, length, fabric, details), not generic ("top").

Brands: name a brand or product only when it is actually identifiable - a visible logo, tag, caption/on-screen
text, or an unmistakable signature design (e.g. Adidas Samba three stripes + T-toe). Say what the evidence is.
Otherwise leave brand null and brand_confidence "none". Never guess a brand to seem helpful.

search_query: what you would type into Google Shopping to find this exact item (brand + model when known),
or the closest match when unbranded. Aesthetic tags: 3-8 short lowercase style labels."""


def _image_block(path: Path) -> dict:
    return {
        "type": "image",
        "source": {"type": "base64", "media_type": "image/jpeg", "data": base64.standard_b64encode(path.read_bytes()).decode()},
    }


def _client() -> anthropic.AsyncAnthropic:
    return anthropic.AsyncAnthropic(api_key=get_settings().anthropic_api_key or None, max_retries=3)


async def analyze_frames(frames: list[Path], media_type: str, caption: str | None = None) -> StyleAnalysis:
    s = get_settings()
    intro = f"{len(frames)} frames from one video, in order." if media_type == "video" else "One photo."
    if caption:
        intro += f"\nPost caption / title (may name brands): {caption[:1000]}"
    content = [*(_image_block(f) for f in frames), {"type": "text", "text": intro + "\nCatalogue this look."}]

    response = await _client().beta.messages.parse(
        model=s.analysis_model,
        max_tokens=16000,
        system=SYSTEM,
        messages=[{"role": "user", "content": content}],
        output_format=StyleAnalysis,
        thinking={"type": "adaptive"},
        # Server-side fallback: if the primary model declines, the API retries on a suitable model in the same call.
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    )
    if response.stop_reason == "refusal":
        raise RuntimeError("The model declined to analyse this media")
    if response.parsed_output is None:
        raise RuntimeError(f"No structured output (stop_reason={response.stop_reason})")
    return response.parsed_output


def shopping_links(query: str, image_url: str | None) -> dict[str, str]:
    links = {
        "google_shopping": f"https://www.google.com/search?tbm=shop&q={quote_plus(query)}",
        "depop": f"https://www.depop.com/search/?q={quote_plus(query)}",
        "ebay": f"https://www.ebay.com/sch/i.html?_nkw={quote_plus(query)}",
    }
    if image_url:
        links["google_lens"] = f"https://lens.google.com/uploadbyurl?url={quote_plus(image_url)}"
    return links


def to_clothing_items(analysis: StyleAnalysis, image_url: str | None) -> list[dict]:
    return [
        {**p.model_dump(), "source": "ai", "links": shopping_links(p.search_query, image_url)}
        for p in analysis.pieces
    ]
