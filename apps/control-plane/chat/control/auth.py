"""Per-runtime-instance credentials.

A runtime's token is derived from its instance id and generation, so it stops
working as soon as a new generation takes over. Identity in request bodies is
never trusted.
"""

import hashlib
import hmac

from django.conf import settings


def runtime_token(instance_id, generation: int) -> str:
    message = f"runtime:{instance_id}:{generation}".encode()
    return hmac.new(settings.SECRET_KEY.encode(), message, hashlib.sha256).hexdigest()


def bearer(request) -> str:
    header = request.headers.get("Authorization", "")
    return header[7:] if header.startswith("Bearer ") else ""


def token_matches(token: str, instance) -> bool:
    expected = runtime_token(instance.id, instance.generation)
    return hmac.compare_digest(token.encode(), expected.encode())
