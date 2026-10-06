"""Idempotency-Key handling for product POST endpoints (RFC §3.4).

The handler runs inside the same transaction that records the key, so a stored
response always corresponds to committed side effects. Errors raised by the
handler roll back and do not consume the key.
"""

import hashlib
import json
from collections.abc import Callable

from django.db import IntegrityError, transaction
from django.http import HttpRequest

from .errors import ApiError
from .models import ApiIdempotency

HEADER = "Idempotency-Key"
MAX_KEY_LENGTH = 255

# (status, json body, resource id)
HandlerResult = tuple[int, dict, str | None]


def _request_hash(payload: dict) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def _lookup(request: HttpRequest, key: str) -> ApiIdempotency | None:
    return ApiIdempotency.objects.filter(
        method=request.method, canonical_path=request.path, key=key
    ).first()


def _replay(record: ApiIdempotency, request_hash: str) -> tuple[int, dict]:
    if record.request_hash != request_hash:
        raise ApiError(
            409, "IDEMPOTENCY_KEY_REUSED", "Idempotency-Key 已用于不同的请求。"
        )
    return record.response_status, record.response_body


def run_idempotent(
    request: HttpRequest, payload: dict, handler: Callable[[], HandlerResult]
) -> tuple[int, dict]:
    key = request.headers.get(HEADER, "").strip()
    if not key or len(key) > MAX_KEY_LENGTH:
        raise ApiError(
            400, "IDEMPOTENCY_KEY_REQUIRED", "请求缺少有效的 Idempotency-Key。"
        )
    request_hash = _request_hash(payload)

    existing = _lookup(request, key)
    if existing:
        return _replay(existing, request_hash)

    try:
        with transaction.atomic():
            status, body, resource_id = handler()
            ApiIdempotency.objects.create(
                method=request.method,
                canonical_path=request.path,
                key=key,
                request_hash=request_hash,
                response_status=status,
                response_body=body,
                resource_id=resource_id,
            )
    except IntegrityError:
        # A concurrent request with the same key committed first.
        existing = _lookup(request, key)
        if existing is None:
            raise
        return _replay(existing, request_hash)
    return status, body
