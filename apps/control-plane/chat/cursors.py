"""Opaque, signed cursors.

Event cursors encode a ``ui_event`` sequence of the default conversation, so a
cursor issued before the conversation exists (sequence 0) stays valid after it
is created. History cursors encode a message sequence.
"""

from django.core import signing

from .errors import ApiError

_EVENT_SALT = "chat.event-cursor"
_HISTORY_SALT = "chat.history-cursor"


def _invalid() -> ApiError:
    return ApiError(400, "INVALID_CURSOR", "游标无效。")


def _encode(salt: str, seq: int) -> str:
    return signing.dumps({"s": seq}, salt=salt, compress=True)


def _decode(salt: str, cursor: str) -> int:
    try:
        data = signing.loads(cursor, salt=salt)
    except signing.BadSignature as exc:
        raise _invalid() from exc
    seq = data.get("s") if isinstance(data, dict) else None
    if not isinstance(seq, int) or isinstance(seq, bool) or seq < 0:
        raise _invalid()
    return seq


def encode_event_cursor(seq: int) -> str:
    return _encode(_EVENT_SALT, seq)


def decode_event_cursor(cursor: str) -> int:
    return _decode(_EVENT_SALT, cursor)


def encode_history_cursor(seq: int) -> str:
    return _encode(_HISTORY_SALT, seq)


def decode_history_cursor(cursor: str) -> int:
    return _decode(_HISTORY_SALT, cursor)
