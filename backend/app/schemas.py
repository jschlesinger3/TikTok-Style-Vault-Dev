from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field, HttpUrl

DropStatus = Literal["unknown", "upcoming", "live", "sold_out", "error"]


class DropCreate(BaseModel):
    creator_name: str = Field(min_length=1, max_length=200)
    collection_title: str = Field(min_length=1, max_length=300)
    target_url: HttpUrl
    drop_timestamp: datetime | None = None


class DropOut(BaseModel):
    id: int
    creator_name: str
    collection_title: str
    target_url: str
    drop_timestamp: datetime | None
    last_known_price: Decimal | None
    status: DropStatus


class DropChange(BaseModel):
    drop_id: int
    collection_title: str
    old_status: str
    new_status: str
    old_price: Decimal | None
    new_price: Decimal | None
    message: str


class CheckRequest(BaseModel):
    drop_ids: list[int] | None = None  # None = all drops


class CheckResult(BaseModel):
    checked: int
    changes: list[DropChange]
    drops: list[DropOut]
