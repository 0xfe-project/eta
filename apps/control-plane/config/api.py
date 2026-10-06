from django.http import HttpRequest
from ninja import NinjaAPI, Schema

api = NinjaAPI(title="AXP Control Plane", version="0.1.0")


class HealthResponse(Schema):
    status: str
    service: str


@api.get("/health", response=HealthResponse, auth=None)
def health(request: HttpRequest):
    return {"status": "ok", "service": "control-plane"}
