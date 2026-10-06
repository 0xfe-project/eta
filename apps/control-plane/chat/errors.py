"""Product error envelope: ``{"error": {"code", "message", "request_id"}}``."""

import logging
import uuid

from django.http import Http404, HttpRequest, HttpResponse
from ninja import NinjaAPI
from ninja.errors import HttpError, ValidationError

logger = logging.getLogger(__name__)


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, extra=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        # Top-level fields for internal protocol errors, e.g. resume positions.
        self.extra = extra or {}


def not_found() -> ApiError:
    return ApiError(404, "NOT_FOUND", "资源不存在。")


def request_id(request: HttpRequest) -> str:
    if not hasattr(request, "request_id"):
        request.request_id = uuid.uuid4().hex
    return request.request_id


def error_response(
    api: NinjaAPI,
    request: HttpRequest,
    status: int,
    code: str,
    message: str,
    extra=None,
) -> HttpResponse:
    body = {
        "error": {"code": code, "message": message, "request_id": request_id(request)},
        **(extra or {}),
    }
    return api.create_response(request, body, status=status)


_HTTP_ERROR_CODES = {
    400: ("BAD_REQUEST", "请求格式无效。"),
    403: ("FORBIDDEN", "请求被拒绝。"),
    404: ("NOT_FOUND", "资源不存在。"),
    405: ("METHOD_NOT_ALLOWED", "不支持该请求方法。"),
    429: ("TOO_MANY_REQUESTS", "请求过于频繁，请稍后再试。"),
}


def install_error_handlers(api: NinjaAPI) -> None:
    @api.exception_handler(ApiError)
    def handle_api_error(request, exc: ApiError):
        return error_response(
            api, request, exc.status, exc.code, exc.message, exc.extra
        )

    @api.exception_handler(HttpError)
    def handle_http_error(request, exc: HttpError):
        code, message = _HTTP_ERROR_CODES.get(
            exc.status_code, ("BAD_REQUEST", "请求无效。")
        )
        return error_response(api, request, exc.status_code, code, message)

    @api.exception_handler(ValidationError)
    def handle_validation_error(request, exc):
        return error_response(api, request, 422, "VALIDATION_ERROR", "请求参数无效。")

    @api.exception_handler(Http404)
    def handle_404(request, exc):
        return error_response(api, request, 404, "NOT_FOUND", "资源不存在。")

    @api.exception_handler(Exception)
    def handle_unexpected(request, exc):
        logger.exception("Unhandled API error (request_id=%s)", request_id(request))
        return error_response(api, request, 500, "INTERNAL_ERROR", "服务暂时不可用。")
