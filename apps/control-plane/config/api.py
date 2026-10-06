from django.http import HttpRequest
from ninja import NinjaAPI, Schema

from chat.api import router as chat_router
from chat.errors import install_error_handlers

api = NinjaAPI(title="AXP Control Plane", version="0.1.0")
install_error_handlers(api)
api.add_router("/v1", chat_router)


class HealthResponse(Schema):
    status: str
    service: str


@api.get("/health", response=HealthResponse)
def health(request: HttpRequest):
    return {"status": "ok", "service": "control-plane"}
