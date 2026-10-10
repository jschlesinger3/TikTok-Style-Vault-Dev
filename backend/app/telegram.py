"""Minimal Telegram client so Style Vault can answer bot uploads when analysis finishes."""
import logging

import httpx

from .config import get_settings

log = logging.getLogger("telegram")


async def send_message(chat_id: int, text: str, reply_to: int | None = None) -> None:
    s = get_settings()
    if not s.telegram_bot_token:
        return
    body = {"chat_id": chat_id, "text": text[:4000], "disable_web_page_preview": True}
    if reply_to:
        body["reply_parameters"] = {"message_id": reply_to, "allow_sending_without_reply": True}
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(f"{s.telegram_api_base}/bot{s.telegram_bot_token}/sendMessage", json=body)
            if r.status_code != 200:
                log.warning("sendMessage failed: %s %s", r.status_code, r.text[:200])
    except httpx.HTTPError as e:
        log.warning("sendMessage failed: %s", e)
