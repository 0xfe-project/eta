"""The controller's routine steps: start runs when schedules fire, watch them,
and revise briefs from feedback.

A run is a fresh container from the agent runtime image running
``python -m axp_runtime.routine``. It reads nothing from earlier runs except
through its tools; what it needs to start is in its instructions.
"""

import json
import logging
import os
import threading
import urllib.request
from datetime import timedelta
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db import IntegrityError, close_old_connections, transaction
from django.utils import timezone

from chat import llm, queue
from chat.control.auth import routine_token
from chat.control.driver import RuntimeSpec

from . import schedule as schedules
from .models import Routine, RoutineBrief, RoutineFeedback, RoutineRun

logger = logging.getLogger(__name__)

RUN_LIMIT = timedelta(minutes=15)
# A run whose container is gone gets this long to report how it ended.
EXIT_GRACE = timedelta(seconds=30)
RUNTIME_OTLP_ENDPOINT = "http://otel-collector:4318"
REVISE_TIMEOUT_SECONDS = 120

INSTRUCTIONS = """你在执行定时任务「{name}」。
它按计划自动运行（{schedule}，时区 {timezone}）。
每次运行都在一个全新的环境里，之前运行留下的文件都不在了。
没有用户在线，不要提问，自己做决定。

## 要求（v{version}）

{brief}

## 上一次运行留下的交接说明

{handoff}

## 怎么做

- 需要了解之前做过什么时，用 list_runs、get_run、search_runs 查看过往的报告
  和用户的反馈。
  发送之前确认内容没有和以前的报告重复；没有值得发送的新内容就不发。
- 最后调用一次 finish 结束运行：
  - report 是给用户的报告（Markdown，第一行是 # 标题），没有新内容时传 null；
  - handoff 写给下一次运行：发了什么、观察到什么、下次要注意什么，几句话即可。"""

PROMPT = "现在是 {now}，执行这次运行。"

REVISE = """你维护一个定时任务的要求。用户对某次运行的报告提了反馈。
把反馈吸收进要求，输出修订后的完整要求：保留原来的写法和语言，只改需要改的地方，不加解释。

## 当前要求

{brief}

## 那次运行的报告

{report}

## 用户的反馈

{feedback}"""


def sync_schedules() -> None:
    """Give NATS every enabled routine's schedule (on controller start)."""
    for routine in Routine.objects.filter(enabled=True):
        queue.schedule_routine(
            routine.id, schedules.cron(routine.schedule), routine.timezone
        )


# --- runs ---------------------------------------------------------------------


def start_fired(driver) -> None:
    for routine_id, now in queue.take_fires():
        routine = Routine.objects.filter(pk=routine_id).first()
        if routine is None or not (routine.enabled or now):
            continue
        try:
            with transaction.atomic():
                run = RoutineRun.objects.create(routine=routine)
        except IntegrityError:
            logger.info("Routine %s is still running; skipping a run", routine_id)
            continue
        try:
            started = driver.start(_spec(driver, routine, run))
        except Exception:
            logger.exception("Failed to start routine run %s", run.pk)
            _fail(run, "运行环境无法启动。")
            continue
        RoutineRun.objects.filter(pk=run.pk).update(container_id=started.container_id)


def _spec(driver, routine: Routine, run: RoutineRun) -> RuntimeSpec:
    brief = routine.briefs.first()
    last = routine.runs.exclude(pk=run.pk).filter(handoff__isnull=False).first()
    local = timezone.localtime(run.started_at, ZoneInfo(routine.timezone))
    instructions = INSTRUCTIONS.format(
        name=routine.name,
        schedule=schedules.describe(routine.schedule),
        timezone=routine.timezone,
        version=brief.version,
        brief=brief.text,
        handoff=(
            f"（{timezone.localtime(last.finished_at, local.tzinfo):%m-%d %H:%M}）"
            f"{last.handoff}"
            if last
            else "这是第一次运行。"
        ),
    )
    env = {
        "AXP_AGENT_ID": f"routine-{routine.pk}",
        "AXP_INSTANCE_ID": str(run.pk),
        "AXP_GENERATION": "0",
        "AXP_RUNTIME_TOKEN": routine_token(run.pk),
        "AXP_GATEWAY_URL": settings.AXP_RUNTIME_GATEWAY_URL,
        "AXP_NATS_URL": settings.AXP_NATS_URL,
        "AXP_CODEX_SETTINGS": json.dumps(
            {
                "model": routine.model,
                "model_context_window": llm.context_window(routine.model),
                "developer_instructions": instructions,
            }
        ),
        "AXP_ROUTINE_PROMPT": PROMPT.format(now=f"{local:%Y-%m-%d %H:%M %Z}"),
        "OTEL_EXPORTER_OTLP_ENDPOINT": RUNTIME_OTLP_ENDPOINT,
        "OTEL_SERVICE_NAME": "routine-runtime",
        "OTEL_RESOURCE_ATTRIBUTES": ",".join(
            a
            for a in (
                os.environ.get("OTEL_RESOURCE_ATTRIBUTES", ""),
                f"axp.routine.id={routine.pk}",
                f"axp.routine.run.id={run.pk}",
            )
            if a
        ),
    }
    if settings.AXP_CODEX_LAUNCH:
        env["AXP_CODEX_LAUNCH"] = settings.AXP_CODEX_LAUNCH
    return RuntimeSpec(
        agent_id=f"routine-{routine.pk}",
        instance_id=str(run.pk),
        generation=0,
        name=driver.name(f"routine-{run.pk}"),
        env=env,
        command=["python", "-m", "axp_runtime.routine"],
    )


def _fail(run: RoutineRun, error: str) -> None:
    RoutineRun.objects.filter(pk=run.pk, status=RoutineRun.Status.RUNNING).update(
        status=RoutineRun.Status.FAILED, error=error, finished_at=timezone.now()
    )


def watch_runs(driver) -> None:
    """Stop runs over time, fail runs whose runtime died, remove finished
    runs' containers."""
    now = timezone.now()
    for run in RoutineRun.objects.filter(container_id__isnull=False):
        if run.status == RoutineRun.Status.RUNNING:
            if run.started_at < now - RUN_LIMIT:
                _fail(run, "运行超过 15 分钟，已停止。")
            elif driver.state(run.container_id) == "running":
                continue
            elif run.started_at < now - EXIT_GRACE:
                _fail(run, "运行意外结束。")
            else:
                continue
        driver.stop(run.container_id)
        RoutineRun.objects.filter(pk=run.pk).update(container_id=None)


# --- feedback -----------------------------------------------------------------

_revising: set = set()
_revising_lock = threading.Lock()


def revise_briefs() -> None:
    """Revise briefs from new feedback, each in the background."""
    pending = RoutineFeedback.objects.filter(
        revision__isnull=True, revision_failed=False
    ).values_list("pk", flat=True)
    for feedback_id in pending:
        with _revising_lock:
            if feedback_id in _revising:
                continue
            _revising.add(feedback_id)
        _in_background(_revise, feedback_id)


def _in_background(target, *args) -> None:
    def run():
        try:
            target(*args)
        finally:
            close_old_connections()

    threading.Thread(target=run, name="revise", daemon=True).start()


def _revise(feedback_id) -> None:
    try:
        feedback = RoutineFeedback.objects.select_related("run__routine").get(
            pk=feedback_id
        )
        routine = feedback.run.routine
        brief = routine.briefs.first()
        text = _complete(
            routine,
            REVISE.format(
                brief=brief.text,
                report=feedback.run.report or feedback.run.error or "（没有报告）",
                feedback=feedback.text,
            ),
        )
        with transaction.atomic():
            latest = routine.briefs.select_for_update().first()
            RoutineBrief.objects.create(
                routine=routine,
                version=latest.version + 1,
                text=text,
                feedback=feedback,
            )
    except Exception:
        logger.exception("Revising the brief from feedback %s failed", feedback_id)
        RoutineFeedback.objects.filter(pk=feedback_id).update(revision_failed=True)
    finally:
        with _revising_lock:
            _revising.discard(feedback_id)


def _complete(routine: Routine, prompt: str) -> str:
    """One chat completion with the routine's model, through the LLM gateway."""
    request = urllib.request.Request(
        f"{settings.AXP_LLM_GATEWAY_URL}/v1/chat/completions",
        data=json.dumps(
            {
                "model": routine.model,
                "messages": [{"role": "user", "content": prompt}],
            }
        ).encode(),
        method="POST",
    )
    request.add_header("Content-Type", "application/json")
    request.add_header("X-AXP-Agent-Id", f"routine-{routine.pk}")
    with urllib.request.urlopen(request, timeout=REVISE_TIMEOUT_SECONDS) as response:
        body = json.loads(response.read())
    text = (body["choices"][0]["message"]["content"] or "").strip()
    if not text:
        raise ValueError("empty revision")
    return text
