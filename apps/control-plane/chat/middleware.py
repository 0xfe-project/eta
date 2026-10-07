import hmac
import json
import re
import uuid

from django.conf import settings
from django.http import HttpResponse

_REQUEST_ID = re.compile(r"^[A-Za-z0-9._-]{8,128}$")


class RequestIdMiddleware:
    """Attach a request id that error bodies and logs can reference.

    The edge gateway assigns one per request; keep it so gateway and service
    logs line up.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        incoming = request.headers.get("X-Request-Id", "")
        request.request_id = (
            incoming if _REQUEST_ID.match(incoming) else uuid.uuid4().hex
        )
        response = self.get_response(request)
        response["X-Request-ID"] = request.request_id
        return response


class EdgeSecretMiddleware:
    """Reject public API requests that did not come through the edge gateway.

    The gateway adds ``X-AXP-Edge-Secret`` to every request it forwards. Health
    checks stay open, and the internal runtime API (its own URLconf, reachable
    only on the runtime network) is not affected. An empty secret disables the
    check.
    """

    OPEN_PATHS = {"/api/health"}

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        secret = settings.AXP_EDGE_SECRET
        if (
            secret
            and settings.ROOT_URLCONF != "config.internal_urls"
            and request.path not in self.OPEN_PATHS
            and not hmac.compare_digest(
                request.headers.get("X-AXP-Edge-Secret", "").encode(), secret.encode()
            )
        ):
            body = {
                "error": {
                    "code": "FORBIDDEN",
                    "message": "请求被拒绝。",
                    "request_id": request.request_id,
                }
            }
            return HttpResponse(
                json.dumps(body, ensure_ascii=False),
                status=403,
                content_type="application/json",
            )
        return self.get_response(request)
