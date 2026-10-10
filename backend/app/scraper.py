"""Fetch a product/collection page and extract price + availability heuristically."""
import asyncio
import ipaddress
import json
import re
import socket
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

from .config import get_settings

UA = "Mozilla/5.0 (compatible; StyleVaultBot/1.0)"
MAX_BYTES = 3_000_000
MAX_REDIRECTS = 5

_PRICE_RE = re.compile(r"[$€£]\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)")
_SOLD_OUT = re.compile(r"\b(sold[\s-]?out|out of stock|unavailable)\b", re.I)
_UPCOMING = re.compile(r"\b(coming soon|notify me|pre[\s-]?order|drops? (?:on|at|in)|launching|waitlist|join the list)\b", re.I)
_LIVE = re.compile(r"\b(add to (?:cart|bag)|buy now|shop now)\b", re.I)

_SCHEMA_STATUS = {
    "instock": "live", "onlineonly": "live", "limitedavailability": "live",
    "outofstock": "sold_out", "soldout": "sold_out", "discontinued": "sold_out",
    "preorder": "upcoming", "presale": "upcoming", "backorder": "upcoming",
}


class ScrapeError(Exception):
    pass


@dataclass
class ScrapeResult:
    status: str
    price: Decimal | None
    title: str | None


def _is_public_host(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False
    return bool(infos) and all(ipaddress.ip_address(i[4][0]).is_global for i in infos)


async def assert_public_url(url: str) -> None:
    """SSRF guard: users supply URLs, so never let the server fetch internal addresses."""
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise ScrapeError("Only http(s) URLs are allowed")
    if not await asyncio.to_thread(_is_public_host, p.hostname):
        raise ScrapeError("URL resolves to a non-public address")


async def _fetch_httpx(url: str) -> str:
    timeout = get_settings().scraper_timeout_seconds
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, headers={"User-Agent": UA}) as client:
        for _ in range(MAX_REDIRECTS + 1):
            await assert_public_url(url)
            async with client.stream("GET", url) as r:
                if r.is_redirect:
                    url = urljoin(url, r.headers.get("location", ""))
                    continue
                if r.status_code >= 400:
                    raise ScrapeError(f"HTTP {r.status_code}")
                body = b""
                async for chunk in r.aiter_bytes():
                    body += chunk
                    if len(body) > MAX_BYTES:
                        break
                return body.decode(r.encoding or "utf-8", errors="replace")
        raise ScrapeError("Too many redirects")


async def _fetch_playwright(url: str) -> str:
    try:
        from playwright.async_api import async_playwright
    except ImportError as e:  # pragma: no cover
        raise ScrapeError("Playwright not installed (build with INSTALL_PLAYWRIGHT=true)") from e
    await assert_public_url(url)
    timeout_ms = get_settings().scraper_timeout_seconds * 1000
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(args=["--no-sandbox"])
        try:
            page = await browser.new_page(user_agent=UA)

            async def guard(route):  # re-check every navigation hop, incl. redirects
                req = route.request
                if req.is_navigation_request():
                    try:
                        await assert_public_url(req.url)
                    except ScrapeError:
                        return await route.abort()
                await route.continue_()

            await page.route("**/*", guard)
            await page.goto(url, wait_until="networkidle", timeout=timeout_ms)
            return await page.content()
        finally:
            await browser.close()


def _to_price(v) -> Decimal | None:
    try:
        d = Decimal(str(v).replace(",", "").strip())
        return d if d >= 0 else None
    except (InvalidOperation, AttributeError):
        return None


def _walk_jsonld(node, out: list[dict]) -> None:
    if isinstance(node, list):
        for n in node:
            _walk_jsonld(n, out)
    elif isinstance(node, dict):
        if "offers" in node:
            offers = node["offers"]
            out.extend(o for o in (offers if isinstance(offers, list) else [offers]) if isinstance(o, dict))
        for v in node.values():
            if isinstance(v, (dict, list)):
                _walk_jsonld(v, out)


def parse_html(html: str) -> ScrapeResult:
    soup = BeautifulSoup(html, "lxml")
    title = (soup.find("meta", property="og:title") or {}).get("content") or (soup.title.string.strip() if soup.title and soup.title.string else None)

    price: Decimal | None = None
    status: str | None = None

    # 1) Structured data (most reliable)
    offers: list[dict] = []
    for tag in soup.find_all("script", type="application/ld+json"):
        try:
            _walk_jsonld(json.loads(tag.string or ""), offers)
        except (json.JSONDecodeError, TypeError):
            continue
    for o in offers:
        price = price or _to_price(o.get("price") or o.get("lowPrice"))
        avail = str(o.get("availability", "")).rsplit("/", 1)[-1].lower()
        status = status or _SCHEMA_STATUS.get(avail)

    # 2) Meta / microdata price
    if price is None:
        for attrs in ({"property": "product:price:amount"}, {"property": "og:price:amount"}, {"itemprop": "price"}):
            el = soup.find(["meta", "span", "div"], attrs=attrs)
            if el:
                price = _to_price(el.get("content") or el.get_text())
                if price is not None:
                    break

    # 3) Visible text heuristics
    for t in soup(["script", "style", "noscript"]):
        t.decompose()
    text = soup.get_text(" ", strip=True)
    if price is None and (m := _PRICE_RE.search(text)):
        price = _to_price(m.group(1))
    if status is None:
        if _SOLD_OUT.search(text):
            status = "sold_out"
        elif _UPCOMING.search(text):
            status = "upcoming"
        elif _LIVE.search(text):
            status = "live"
    return ScrapeResult(status or "unknown", price, title)


async def scrape(url: str) -> ScrapeResult:
    try:
        html = await (_fetch_playwright(url) if get_settings().scraper_use_playwright else _fetch_httpx(url))
    except ScrapeError:
        raise
    except Exception as e:  # network errors, timeouts, etc.
        raise ScrapeError(f"{type(e).__name__}: {e}") from e
    return parse_html(html)
