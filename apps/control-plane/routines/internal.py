"""Internal API for routine runs (on the internal runtime API process).

A run authenticates with its token; it reads its routine's earlier runs and
says how it ended. Nothing here lets it see another routine.
"""

import hmac
import uuid
from datetime import datetime

from django.db.models import Q
from django.http import HttpRequest
from django.utils import timezone
from ninja import Router, Schema
from pydantic import ConfigDict, Field

from chat.control.auth import bearer, routine_token
from chat.errors import ApiError

from .models import RoutineRun

router = Router(tags=["routine runs"])

MAX_PAGE = 50


class _In(Schema):
    model_config = ConfigDict(extra="ignore")


class FinishIn(_In):
    report: str | None = Field(None, max_length=100_000)
    handoff: str = Field("", max_length=4000)


class CompleteIn(_In):
    completed: bool
    message: str = Field("", max_length=100_000)
    error: str | None = Field(None, max_length=500)


def run_for(run_id, token: str) -> RoutineRun | None:
    """The running run this token belongs to."""
    try:
        run_id = uuid.UUID(str(run_id))
    except ValueError:
        return None
    if not hmac.compare_digest(token.encode(), routine_token(run_id).encode()):
        return None
    return (
        RoutineRun.objects.select_related("routine")
        .filter(pk=run_id, container_id__isnull=False)
        .first()
    )


def _run(request: HttpRequest, run_id: str) -> RoutineRun:
    run = run_for(run_id, bearer(request))
    if run is None:
        raise ApiError(403, "INVALID_RUNTIME_TOKEN", "运行令牌无效。")
    return run


def _summary(run: RoutineRun, full: bool = False) -> dict:
    body = {
        "id": str(run.id),
        "started_at": run.started_at.isoformat(),
        "status": run.status,
        "title": run.title,
        "feedback": [f.text for f in run.feedback.all()],
    }
    if full:
        body |= {"report": run.report, "handoff": run.handoff, "error": run.error}
    return body


@router.get("/{run_id}/runs")
def list_runs(
    request: HttpRequest,
    run_id: str,
    before: datetime | None = None,
    q: str | None = None,
    limit: int = 10,
):
    run = _run(request, run_id)
    runs = run.routine.runs.exclude(pk=run.pk).exclude(status=RoutineRun.Status.RUNNING)
    if before:
        runs = runs.filter(started_at__lt=before)
    if q:
        runs = runs.filter(Q(report__icontains=q) | Q(handoff__icontains=q))
    runs = runs.prefetch_related("feedback")[: max(1, min(limit, MAX_PAGE))]
    return [_summary(other) for other in runs]


@router.get("/{run_id}/runs/{other_id}")
def get_run(request: HttpRequest, run_id: str, other_id: str):
    run = _run(request, run_id)
    try:
        other = run.routine.runs.filter(pk=uuid.UUID(other_id)).first()
    except ValueError:
        other = None
    if other is None:
        raise ApiError(404, "NOT_FOUND", "没有这次运行。")
    return _summary(other, full=True)


@router.post("/{run_id}/finish")
def finish(request: HttpRequest, run_id: str, body: FinishIn):
    run = _run(request, run_id)
    if run.status != RoutineRun.Status.RUNNING:
        raise ApiError(409, "RUN_FINISHED", "这次运行已经结束。")
    report = (body.report or "").strip() or None
    run.status = RoutineRun.Status.SENT if report else RoutineRun.Status.NOTHING_NEW
    run.report = report
    run.handoff = body.handoff.strip() or None
    run.finished_at = timezone.now()
    run.save(update_fields=["status", "report", "handoff", "finished_at"])
    return {"status": run.status}


@router.post("/{run_id}/complete")
def complete(request: HttpRequest, run_id: str, body: CompleteIn):
    """The runtime is done. Without a ``finish``, its last message is the
    report, or the run failed."""
    run = _run(request, run_id)
    if run.status != RoutineRun.Status.RUNNING:
        return {"status": run.status}
    message = body.message.strip()
    if body.completed and message:
        run.status = RoutineRun.Status.SENT
        run.report = message
    else:
        run.status = RoutineRun.Status.FAILED
        run.error = body.error or "运行没有完成。"
    run.finished_at = timezone.now()
    run.save(update_fields=["status", "report", "error", "finished_at"])
    return {"status": run.status}
