"""Drop checking pipeline + periodic background loop."""
import asyncio
import logging

from .config import get_settings
from .db import pool
from .scraper import ScrapeError, scrape
from .schemas import DropChange

log = logging.getLogger("tracker")
_lock = asyncio.Lock()  # manual sync and the periodic loop must not overlap
_CONCURRENCY = 4


async def _check_one(row, sem: asyncio.Semaphore):
    async with sem:
        try:
            return row, await scrape(row["target_url"]), None
        except ScrapeError as e:
            return row, None, str(e)


def _describe(row, new_status: str, new_price) -> str:
    parts = []
    if new_status != row["status"]:
        parts.append(f"status {row['status']} → {new_status}")
    if new_price is not None and new_price != row["last_known_price"]:
        old = f"${row['last_known_price']}" if row["last_known_price"] is not None else "n/a"
        parts.append(f"price {old} → ${new_price}")
    return f"{row['collection_title']}: " + ", ".join(parts)


async def check_drops(drop_ids: list[int] | None = None) -> tuple[int, list[DropChange]]:
    async with _lock:
        async with pool().acquire() as conn:
            rows = await conn.fetch(
                "SELECT * FROM drops WHERE ($1::bigint[] IS NULL OR id = ANY($1)) ORDER BY id", drop_ids
            )
        sem = asyncio.Semaphore(_CONCURRENCY)
        results = await asyncio.gather(*(_check_one(r, sem) for r in rows))

        changes: list[DropChange] = []
        async with pool().acquire() as conn:
            for row, res, err in results:
                if err:
                    log.warning("drop %s failed: %s", row["id"], err)
                    new_status, new_price = "error", None  # keep last known price
                else:
                    new_status, new_price = res.status, res.price
                # A transient failure shouldn't clobber a known status with 'unknown'.
                if new_status == "unknown" and row["status"] != "unknown":
                    new_status = row["status"]
                price_changed = new_price is not None and new_price != row["last_known_price"]
                if new_status == row["status"] and not price_changed:
                    continue
                await conn.execute(
                    "UPDATE drops SET status=$2, last_known_price=COALESCE($3, last_known_price) WHERE id=$1",
                    row["id"], new_status, new_price,
                )
                changes.append(DropChange(
                    drop_id=row["id"], collection_title=row["collection_title"],
                    old_status=row["status"], new_status=new_status,
                    old_price=row["last_known_price"], new_price=new_price if price_changed else row["last_known_price"],
                    message=_describe(row, new_status, new_price),
                ))
        return len(rows), changes


async def periodic_loop() -> None:
    minutes = get_settings().scraper_interval_minutes
    if minutes <= 0:
        log.info("periodic scraping disabled")
        return
    while True:
        await asyncio.sleep(minutes * 60)
        try:
            n, changes = await check_drops()
            log.info("periodic check: %d drops, %d changes", n, len(changes))
        except Exception:
            log.exception("periodic check failed")
