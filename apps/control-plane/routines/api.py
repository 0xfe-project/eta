"""Public routine API: the web client's routines tab."""

import uuid
from datetime import datetime

from django.http import HttpRequest, HttpResponse
from ninja import Router, Schema, Status
from pydantic import ConfigDict, Field

from chat.errors import not_found
from chat.idempotency import run_idempotent
from chat.schemas import ErrorOut

from . import services
from .schedule import Schedule

router = Router(tags=["routines"])

_ERRORS = {400: ErrorOut, 404: ErrorOut, 409: ErrorOut, 422: ErrorOut, 503: ErrorOut}


class _Input(Schema):
    model_config = ConfigDict(extra="forbid")


class RoutineIn(_Input):
    name: str = Field(min_length=1, max_length=100)
    brief: str = Field(min_length=1, max_length=8000)
    model: str = Field(min_length=1, max_length=200)
    schedule: Schedule
    timezone: str = Field(min_length=1, max_length=64)


class RoutineUpdateIn(_Input):
    name: str | None = Field(None, min_length=1, max_length=100)
    brief: str | None = Field(None, min_length=1, max_length=8000)
    model: str | None = Field(None, min_length=1, max_length=200)
    schedule: Schedule | None = None
    timezone: str | None = Field(None, min_length=1, max_length=64)
    enabled: bool | None = None


class FeedbackIn(_Input):
    text: str = Field(min_length=1, max_length=4000)


class FeedbackOut(Schema):
    id: str
    text: str
    created_at: datetime
    brief_version: int | None
    revision_failed: bool


class RunOut(Schema):
    id: str
    started_at: datetime
    finished_at: datetime | None
    status: str
    title: str | None
    report: str | None
    error: str | None
    feedback: list[FeedbackOut]


class BriefOut(Schema):
    version: int
    text: str
    created_at: datetime
    feedback: str | None


class HandoffOut(Schema):
    text: str
    written_at: datetime


class RoutineOut(Schema):
    id: str
    name: str
    model: str
    schedule: dict
    timezone: str
    enabled: bool
    next_run_at: datetime | None
    briefs: list[BriefOut]
    handoff: HandoffOut | None
    runs: list[RunOut]


class RoutineListOut(Schema):
    routines: list[RoutineOut]


@router.get("/routines", response={200: RoutineListOut, **_ERRORS})
def list_routines(request: HttpRequest):
    return {"routines": services.list_public()}


@router.post("/routines", response={201: RoutineOut, **_ERRORS})
def create_routine(request: HttpRequest, body: RoutineIn):
    def handler():
        routine = services.create(body.model_dump())
        return Status(201, services.public(routine)), str(routine.id)

    return run_idempotent(request, body.model_dump(mode="json"), handler)


@router.patch("/routines/{routine_id}", response={200: RoutineOut, **_ERRORS})
def update_routine(request: HttpRequest, routine_id: str, body: RoutineUpdateIn):
    changes = body.model_dump(exclude_unset=True)
    return services.public(services.update(_uuid(routine_id), changes))


@router.delete("/routines/{routine_id}", response={204: None, **_ERRORS})
def delete_routine(request: HttpRequest, routine_id: str):
    services.delete(_uuid(routine_id))
    return HttpResponse(status=204)


@router.post("/routines/{routine_id}/run", response={202: RoutineOut, **_ERRORS})
def run_routine(request: HttpRequest, routine_id: str):
    services.run_now(_uuid(routine_id))
    return Status(202, services.public(services.get(_uuid(routine_id))))


@router.post(
    "/routines/{routine_id}/briefs/{version}/restore",
    response={200: RoutineOut, **_ERRORS},
)
def restore_brief(request: HttpRequest, routine_id: str, version: int):
    def handler():
        services.restore_brief(_uuid(routine_id), version)
        routine = services.get(_uuid(routine_id))
        return Status(200, services.public(routine)), str(routine.id)

    return run_idempotent(request, {}, handler)


@router.post(
    "/routines/{routine_id}/runs/{run_id}/feedback",
    response={201: FeedbackOut, **_ERRORS},
)
def add_feedback(request: HttpRequest, routine_id: str, run_id: str, body: FeedbackIn):
    def handler():
        feedback = services.add_feedback(
            _uuid(routine_id), _uuid(run_id), body.text.strip()
        )
        return Status(201, services.feedback_public(feedback)), str(feedback.id)

    return run_idempotent(request, body.model_dump(), handler)


def _uuid(value: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except ValueError as exc:
        raise not_found() from exc
