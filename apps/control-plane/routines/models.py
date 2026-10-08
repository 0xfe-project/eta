"""Routines (docs/architecture/routines.md): agents that run on a schedule.

A routine has a versioned brief and a history of runs. Each run happens in a
fresh runtime, may leave a report, and always leaves a handoff note for the
next run. The user's feedback on a run revises the brief.
"""

import uuid

from django.db import models
from django.db.models import Q
from django.utils.timezone import now


class Routine(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=100)
    model = models.CharField(max_length=200)
    # routines.schedule.Schedule, as JSON.
    schedule = models.JSONField()
    timezone = models.CharField(max_length=64)
    enabled = models.BooleanField(default=True)
    created_at = models.DateTimeField(default=now)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "routine"
        ordering = ["created_at"]


class RoutineRun(models.Model):
    class Status(models.TextChoices):
        RUNNING = "running"
        SENT = "sent"
        NOTHING_NEW = "nothing_new"
        FAILED = "failed"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    routine = models.ForeignKey(Routine, on_delete=models.CASCADE, related_name="runs")
    status = models.CharField(
        max_length=16, choices=Status.choices, default=Status.RUNNING
    )
    started_at = models.DateTimeField(default=now)
    finished_at = models.DateTimeField(null=True, blank=True)
    report = models.TextField(null=True, blank=True)
    # Written by the run for the next one.
    handoff = models.TextField(null=True, blank=True)
    error = models.CharField(max_length=500, null=True, blank=True)
    # Its runtime container, until the controller removes it.
    container_id = models.CharField(max_length=100, null=True, blank=True)

    class Meta:
        db_table = "routine_run"
        ordering = ["-started_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["routine"],
                condition=Q(status="running"),
                name="one_running_run_per_routine",
            )
        ]

    @property
    def title(self) -> str | None:
        """The report's first heading, or its first line."""
        if not self.report:
            return None
        first = self.report.strip().splitlines()[0]
        return first.lstrip("#").strip()[:200] or None


class RoutineFeedback(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    run = models.ForeignKey(
        RoutineRun, on_delete=models.CASCADE, related_name="feedback"
    )
    text = models.TextField()
    created_at = models.DateTimeField(default=now)
    # The revision could not be made; the brief stays as it was.
    revision_failed = models.BooleanField(default=False)

    class Meta:
        db_table = "routine_feedback"
        ordering = ["created_at"]


class RoutineBrief(models.Model):
    routine = models.ForeignKey(
        Routine, on_delete=models.CASCADE, related_name="briefs"
    )
    version = models.IntegerField()
    text = models.TextField()
    # The feedback this version was revised from; none when the user wrote it.
    feedback = models.OneToOneField(
        RoutineFeedback,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="revision",
    )
    created_at = models.DateTimeField(default=now)

    class Meta:
        db_table = "routine_brief"
        ordering = ["-version"]
        constraints = [
            models.UniqueConstraint(
                fields=["routine", "version"], name="routine_brief_version_uniq"
            )
        ]
