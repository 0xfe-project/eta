"""When a routine runs: the browser's schedule shapes, as cron.

NATS fires the schedule (six-field cron, with seconds); croniter tells the
browser when it will next.
"""

from datetime import datetime
from typing import Annotated, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from croniter import croniter
from pydantic import BaseModel, Field, TypeAdapter

from chat.errors import ApiError

Time = Annotated[str, Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")]


class Daily(BaseModel):
    kind: Literal["daily"]
    time: Time


class Weekly(BaseModel):
    kind: Literal["weekly"]
    # 0 is Sunday, as in cron.
    days: list[Annotated[int, Field(ge=0, le=6)]] = Field(min_length=1, max_length=7)
    time: Time


class Hourly(BaseModel):
    kind: Literal["hourly"]
    every: Literal[1, 2, 3, 4, 6, 8, 12]


class Cron(BaseModel):
    kind: Literal["cron"]
    cron: str = Field(max_length=100)


Schedule = Annotated[Daily | Weekly | Hourly | Cron, Field(discriminator="kind")]
_schedule = TypeAdapter(Schedule)


def cron(schedule: dict) -> str:
    """Five-field cron."""
    s = _schedule.validate_python(schedule)
    if isinstance(s, Cron):
        return s.cron.strip()
    if isinstance(s, Hourly):
        return f"0 */{s.every} * * *"
    hh, mm = (int(part) for part in s.time.split(":"))
    days = "*" if isinstance(s, Daily) else ",".join(map(str, sorted(set(s.days))))
    return f"{mm} {hh} * * {days}"


def validate(schedule: dict, timezone: str) -> None:
    try:
        ZoneInfo(timezone)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ApiError(422, "INVALID_TIMEZONE", "时区无效。") from exc
    if not croniter.is_valid(cron(schedule)):
        raise ApiError(422, "INVALID_SCHEDULE", "cron 表达式无效。")


def next_run(schedule: dict, timezone: str, after: datetime) -> datetime:
    start = after.astimezone(ZoneInfo(timezone))
    return croniter(cron(schedule), start).get_next(datetime)


def describe(schedule: dict) -> str:
    s = _schedule.validate_python(schedule)
    if isinstance(s, Daily):
        return f"每天 {s.time}"
    if isinstance(s, Weekly):
        names = "日一二三四五六"
        return f"每周{'、'.join(names[d] for d in sorted(set(s.days)))} {s.time}"
    if isinstance(s, Hourly):
        return "每小时" if s.every == 1 else f"每 {s.every} 小时"
    return f"cron {s.cron}"
