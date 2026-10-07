import uuid


class RequestIdMiddleware:
    """Attach a request id that error bodies and logs can reference.

    The gateway assigns one per request; keep it so gateway and service logs
    line up.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        request.request_id = request.headers.get("X-Request-Id") or uuid.uuid4().hex
        response = self.get_response(request)
        response["X-Request-ID"] = request.request_id
        return response
