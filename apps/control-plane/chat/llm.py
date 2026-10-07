"""Client for the LLM gateway's model catalog (apps/llm-gateway).

The control plane calls the LLM gateway directly. It only needs the catalog:
to validate an agent's model, to refuse chats whose model is unusable, and to
tell runtimes a model's context window.
"""

import json
import logging
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass

from django.conf import settings

from .errors import ApiError

logger = logging.getLogger(__name__)

CACHE_SECONDS = 10.0
TIMEOUT_SECONDS = 5.0


@dataclass(frozen=True)
class Model:
    id: str
    connector: str
    display_name: str
    context_window: int | None
    available: bool
    unavailable_message: str | None


class GatewayUnavailable(Exception):
    pass


_lock = threading.Lock()
_cache: tuple[float, dict[str, Model]] | None = None


def _fetch() -> dict[str, Model]:
    url = settings.AXP_LLM_GATEWAY_URL.rstrip("/") + "/api/llm/v1/models"
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT_SECONDS) as response:
            items = json.load(response)
    except (OSError, urllib.error.URLError, ValueError) as exc:
        raise GatewayUnavailable(str(exc)) from exc
    return {
        item["id"]: Model(
            id=item["id"],
            connector=item.get("connector", ""),
            display_name=item.get("display_name") or item["id"],
            context_window=item.get("context_window") or None,
            available=bool(item.get("available")),
            unavailable_message=(item.get("unavailable_reason") or {}).get("message"),
        )
        for item in items
    }


def models(refresh: bool = False) -> dict[str, Model]:
    global _cache
    with _lock:
        if not refresh and _cache and time.monotonic() - _cache[0] < CACHE_SECONDS:
            return _cache[1]
    catalog = _fetch()
    with _lock:
        _cache = (time.monotonic(), catalog)
    return catalog


def validate_model(model_id: str) -> None:
    """Reject model ids the gateway has never offered."""
    try:
        catalog = models()
        if model_id not in catalog:
            catalog = models(refresh=True)
    except GatewayUnavailable as exc:
        logger.warning("LLM gateway unavailable: %s", exc)
        raise ApiError(
            503, "MODEL_SERVICE_UNAVAILABLE", "模型服务暂时不可用，请稍后再试。"
        )
    if model_id not in catalog:
        raise ApiError(422, "MODEL_NOT_FOUND", "所选模型不存在。")


def ensure_usable(model_id: str | None) -> None:
    """Refuse to start a turn the agent's model cannot serve."""
    if not model_id:
        raise ApiError(409, "MODEL_NOT_SET", "这个智能体还没有选择模型。")
    try:
        model = models().get(model_id)
        if model is None or not model.available:
            model = models(refresh=True).get(model_id)
    except GatewayUnavailable as exc:
        logger.warning("LLM gateway unavailable: %s", exc)
        raise ApiError(409, "MODEL_UNAVAILABLE", "模型服务暂时不可用，请稍后再试。")
    if model is None:
        raise ApiError(
            409, "MODEL_UNAVAILABLE", "这个智能体的模型已不存在，请更换模型。"
        )
    if not model.available:
        reason = model.unavailable_message or "请检查模型服务中的账号。"
        raise ApiError(
            409, "MODEL_UNAVAILABLE", f"{model.display_name} 暂不可用：{reason}"
        )


def context_window(model_id: str | None) -> int | None:
    if not model_id:
        return None
    try:
        model = models().get(model_id)
    except GatewayUnavailable:
        return None
    return model.context_window if model else None
