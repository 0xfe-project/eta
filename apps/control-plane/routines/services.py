"""Routine writes and their public shape.

A routine's schedule lives in NATS (chat/queue.py); every write that changes
whether or when it runs updates it in the same request, before commit, so a
failure rolls the write back.
"""

import json
import logging

from django.core.serializers.json import DjangoJSONEncoder
from django.db import transaction
from django.utils import timezone

from chat import llm, queue
from chat.errors import ApiError, not_found

from . import schedule as schedules
from .models import Routine, RoutineBrief, RoutineFeedback, RoutineRun

logger = logging.getLogger(__name__)

# Runs the browser gets per routine.
RUN_HISTORY = 30


def _queue_unavailable(exc: Exception) -> ApiError:
    logger.error("Routine schedule unavailable: %s", exc)
    return ApiError(503, "QUEUE_UNAVAILABLE", "消息队列暂时不可用，请稍后再试。")


def sync_schedule(routine: Routine) -> None:
    try:
        if routine.enabled:
            queue.schedule_routine(
                routine.id, schedules.cron(routine.schedule), routine.timezone
            )
        else:
            queue.unschedule_routine(routine.id)
    except Exception as exc:
        raise _queue_unavailable(exc) from exc


def get(routine_id) -> Routine:
    routine = Routine.objects.filter(pk=routine_id).first()
    if routine is None:
        raise not_found()
    return routine


# --- reads --------------------------------------------------------------------


def _json(obj: dict) -> dict:
    """As the browser gets it (and as idempotent responses are stored)."""
    return json.loads(json.dumps(obj, cls=DjangoJSONEncoder))


def feedback_public(feedback: RoutineFeedback) -> dict:
    revision = getattr(feedback, "revision", None)
    return _json(
        {
            "id": str(feedback.id),
            "text": feedback.text,
            "created_at": feedback.created_at,
            "brief_version": revision.version if revision else None,
            "revision_failed": feedback.revision_failed,
        }
    )


def _run_public(run: RoutineRun) -> dict:
    return {
        "id": str(run.id),
        "started_at": run.started_at,
        "finished_at": run.finished_at,
        "status": run.status,
        "title": run.title,
        "report": run.report,
        "error": run.error,
        "feedback": [feedback_public(f) for f in run.feedback.all()],
    }


def public(routine: Routine) -> dict:
    runs = list(routine.runs.prefetch_related("feedback__revision")[:RUN_HISTORY])
    briefs = routine.briefs.select_related("feedback")
    handoff = next((run for run in runs if run.handoff), None)
    return _json(
        {
            "id": str(routine.id),
            "name": routine.name,
            "model": routine.model,
            "schedule": routine.schedule,
            "timezone": routine.timezone,
            "enabled": routine.enabled,
            "next_run_at": (
                schedules.next_run(routine.schedule, routine.timezone, timezone.now())
                if routine.enabled
                else None
            ),
            "briefs": [
                {
                    "version": brief.version,
                    "text": brief.text,
                    "created_at": brief.created_at,
                    "feedback": brief.feedback.text if brief.feedback else None,
                }
                for brief in briefs
            ],
            "handoff": (
                {"text": handoff.handoff, "written_at": handoff.finished_at}
                if handoff
                else None
            ),
            "runs": [_run_public(run) for run in runs],
        }
    )


def list_public() -> list[dict]:
    return [public(routine) for routine in Routine.objects.all()]


# --- writes -------------------------------------------------------------------


def _add_brief(routine: Routine, text: str, feedback=None) -> RoutineBrief:
    latest = routine.briefs.first()
    return RoutineBrief.objects.create(
        routine=routine,
        version=(latest.version if latest else 0) + 1,
        text=text,
        feedback=feedback,
    )


def create(data: dict) -> Routine:
    llm.validate_model(data["model"])
    schedules.validate(data["schedule"], data["timezone"])
    with transaction.atomic():
        routine = Routine.objects.create(
            name=data["name"],
            model=data["model"],
            schedule=data["schedule"],
            timezone=data["timezone"],
        )
        _add_brief(routine, data["brief"])
        sync_schedule(routine)
    return routine


def update(routine_id, changes: dict) -> Routine:
    if changes.get("model"):
        llm.validate_model(changes["model"])
    with transaction.atomic():
        routine = Routine.objects.select_for_update().filter(pk=routine_id).first()
        if routine is None:
            raise not_found()
        brief = changes.pop("brief", None)
        for field, value in changes.items():
            setattr(routine, field, value)
        schedules.validate(routine.schedule, routine.timezone)
        routine.save()
        if brief is not None and brief != routine.briefs.first().text:
            _add_brief(routine, brief)
        if {"schedule", "timezone", "enabled"} & changes.keys():
            sync_schedule(routine)
    return routine


def delete(routine_id) -> None:
    with transaction.atomic():
        routine = get(routine_id)
        if routine.runs.filter(container_id__isnull=False).exists():
            # Its runtime must go first; the controller removes it.
            raise ApiError(409, "ROUTINE_RUNNING", "这个定时任务正在运行，稍后再删除。")
        try:
            queue.unschedule_routine(routine.id)
        except Exception as exc:
            raise _queue_unavailable(exc) from exc
        routine.delete()


def run_now(routine_id) -> None:
    routine = get(routine_id)
    if routine.runs.filter(status=RoutineRun.Status.RUNNING).exists():
        raise ApiError(409, "ROUTINE_RUNNING", "这个定时任务正在运行。")
    try:
        queue.fire_routine(routine.id)
    except Exception as exc:
        raise _queue_unavailable(exc) from exc


def restore_brief(routine_id, version: int) -> None:
    with transaction.atomic():
        routine = get(routine_id)
        old = routine.briefs.filter(version=version).first()
        if old is None:
            raise not_found()
        _add_brief(routine, old.text)


def add_feedback(routine_id, run_id, text: str) -> RoutineFeedback:
    """The controller revises the brief from it (routines.runner)."""
    run = RoutineRun.objects.filter(pk=run_id, routine_id=routine_id).first()
    if run is None:
        raise not_found()
    return RoutineFeedback.objects.create(run=run, text=text)
