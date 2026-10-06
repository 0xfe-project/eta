"""Server-sent product events replayed from the persistent ``ui_event`` table.

Every event is read back from the database, so a client that reconnects with
its last cursor misses nothing. Polling only decides when to look again.
"""

import json
import time
from collections.abc import Iterator

from django.conf import settings

from . import cursors
from .errors import ApiError
from .models import Conversation, UiEvent
from .services import default_conversation_id

BATCH_SIZE = 100


def resolve_start_seq(cursor: str) -> int:
    seq = cursors.decode_event_cursor(cursor)
    conversation_id = default_conversation_id()
    latest = (
        Conversation.objects.values_list("last_ui_event_seq", flat=True).get(
            pk=conversation_id
        )
        if conversation_id
        else 0
    )
    if seq > latest:
        raise ApiError(410, "CURSOR_EXPIRED", "事件游标已失效，请重新加载。")
    return seq


def format_event(event: UiEvent) -> str:
    data = json.dumps(event.payload, ensure_ascii=False, separators=(",", ":"))
    cursor = cursors.encode_event_cursor(event.seq)
    return f"id: {cursor}\nevent: {event.type}\ndata: {data}\n\n"


def event_stream(
    seq: int,
    *,
    poll_interval: float | None = None,
    heartbeat_interval: float | None = None,
    max_idle_polls: int | None = None,
) -> Iterator[str]:
    poll_interval = poll_interval or settings.CHAT_STREAM_POLL_SECONDS
    heartbeat_interval = heartbeat_interval or settings.CHAT_STREAM_HEARTBEAT_SECONDS
    conversation_id = None
    last_write = time.monotonic()
    idle_polls = 0
    # Tell EventSource how long to wait before reconnecting.
    yield "retry: 3000\n\n"
    while True:
        if conversation_id is None:
            conversation_id = default_conversation_id()
        events = (
            list(
                UiEvent.objects.filter(
                    conversation_id=conversation_id, seq__gt=seq
                ).order_by("seq")[:BATCH_SIZE]
            )
            if conversation_id
            else []
        )
        for event in events:
            seq = event.seq
            yield format_event(event)
        now = time.monotonic()
        if events:
            last_write = now
            idle_polls = 0
            continue
        if now - last_write >= heartbeat_interval:
            # Comment line: keeps proxies open without moving the cursor.
            yield ": heartbeat\n\n"
            last_write = now
        idle_polls += 1
        if max_idle_polls is not None and idle_polls >= max_idle_polls:
            return
        time.sleep(poll_interval)
