import json
from datetime import timedelta
from unittest import mock

import pytest
from django.test import Client, override_settings
from django.utils import timezone

from chat.control.auth import routine_token
from chat.control.controller import Controller
from chat.tests.helpers import TEST_MODEL, error_of
from chat.tests.test_control import FakeDriver
from routines import runner
from routines.models import Routine, RoutineBrief, RoutineFeedback, RoutineRun

pytestmark = pytest.mark.django_db

NEWS = {
    "name": "科技日报",
    "brief": "每天整理科技新闻。",
    "model": TEST_MODEL,
    "schedule": {"kind": "daily", "time": "08:00"},
    "timezone": "Asia/Shanghai",
}


@pytest.fixture
def routine(chat):
    response = chat.post("/routines", NEWS)
    assert response.status_code == 201, response.content
    return response.json()


@pytest.fixture
def ctl(settings):
    settings.AXP_RUNTIME_GATEWAY_URL = "http://runtime-gateway:8090"
    driver = FakeDriver()
    return Controller(driver), driver


def internal(method, path, token, **kwargs):
    with override_settings(ROOT_URLCONF="config.internal_urls"):
        return getattr(Client(), method)(
            f"/internal/v1/{path}", HTTP_AUTHORIZATION=f"Bearer {token}", **kwargs
        )


class Run:
    """Talks to the internal API the way a routine run does."""

    def __init__(self, run: RoutineRun):
        self.run = run
        self.token = routine_token(run.pk)

    def call(self, method, path, body=None, token=None):
        return internal(
            method,
            f"routine-runs/{self.run.pk}/{path}",
            token or self.token,
            data=json.dumps(body) if body is not None else None,
            content_type="application/json",
        )

    def finish(self, report, handoff="交接"):
        return self.call("post", "finish", {"report": report, "handoff": handoff})

    def complete(self, completed=True, message="", error=None):
        body = {"completed": completed, "message": message, "error": error}
        return self.call("post", "complete", body)


def start_run(chat, ctl, routine):
    controller, _ = ctl
    assert chat.post(f"/routines/{routine['id']}/run").status_code == 202
    controller.tick()
    return Run(RoutineRun.objects.get(routine_id=routine["id"], status="running"))


class TestRoutines:
    def test_create_schedules_it(self, routine, nats):
        assert nats.schedules[routine["id"]] == ("0 8 * * *", "Asia/Shanghai")
        assert routine["enabled"] is True
        assert routine["next_run_at"]
        assert [b["version"] for b in routine["briefs"]] == [1]
        assert routine["runs"] == []
        assert routine["handoff"] is None

    @pytest.mark.parametrize(
        ("change", "code"),
        [
            ({"timezone": "Mars/Base"}, "INVALID_TIMEZONE"),
            ({"schedule": {"kind": "cron", "cron": "nope"}}, "INVALID_SCHEDULE"),
        ],
    )
    def test_rejects_bad_schedules(self, chat, change, code):
        response = chat.post("/routines", {**NEWS, **change})
        assert error_of(response) == (422, code)

    def test_schedule_kinds_become_cron(self, chat, nats):
        weekly = {"kind": "weekly", "days": [3, 1], "time": "09:30"}
        made = chat.post("/routines", {**NEWS, "schedule": weekly}).json()
        assert nats.schedules[made["id"]][0] == "30 9 * * 1,3"
        hourly = {"kind": "hourly", "every": 6}
        made = chat.post("/routines", {**NEWS, "schedule": hourly}).json()
        assert nats.schedules[made["id"]][0] == "0 */6 * * *"

    def test_edit_disable_and_delete(self, chat, routine, nats):
        path = f"/routines/{routine['id']}"
        edited = chat.patch(path, {"brief": "改过的要求。"}).json()
        assert [b["version"] for b in edited["briefs"]] == [2, 1]
        disabled = chat.patch(path, {"enabled": False}).json()
        assert disabled["next_run_at"] is None
        assert routine["id"] not in nats.schedules
        chat.patch(path, {"enabled": True})
        assert routine["id"] in nats.schedules
        assert chat.delete(path).status_code == 204
        assert routine["id"] not in nats.schedules
        assert not Routine.objects.exists()

    def test_restore_brief(self, chat, routine):
        path = f"/routines/{routine['id']}"
        chat.patch(path, {"brief": "第二版"})
        restored = chat.post(f"{path}/briefs/1/restore").json()
        assert [(b["version"], b["text"]) for b in restored["briefs"]] == [
            (3, NEWS["brief"]),
            (2, "第二版"),
            (1, NEWS["brief"]),
        ]

    def test_queue_down_keeps_nothing(self, chat, nats):
        nats.down = True
        assert error_of(chat.post("/routines", NEWS)) == (503, "QUEUE_UNAVAILABLE")
        assert not Routine.objects.exists()


class TestRuns:
    def test_fire_starts_a_runtime(self, chat, ctl, routine):
        _, driver = ctl
        run = start_run(chat, ctl, routine)
        [spec] = driver.started
        assert spec.command == ["python", "-m", "axp_runtime.routine"]
        env = spec.env
        assert env["AXP_INSTANCE_ID"] == str(run.run.pk)
        assert env["AXP_RUNTIME_TOKEN"] == run.token
        settings = json.loads(env["AXP_CODEX_SETTINGS"])
        assert settings["model"] == TEST_MODEL
        assert NEWS["brief"] in settings["developer_instructions"]
        assert "这是第一次运行" in settings["developer_instructions"]
        assert env["AXP_ROUTINE_PROMPT"].startswith("现在是")
        # Running already: asking again is refused.
        again = chat.post(f"/routines/{routine['id']}/run")
        assert error_of(again) == (409, "ROUTINE_RUNNING")

    def test_disabled_routine_skips_its_schedule(
        self,
        chat,
        ctl,
        routine,
        nats,
    ):
        controller, driver = ctl
        chat.patch(f"/routines/{routine['id']}", {"enabled": False})
        nats.fires.append((routine["id"], False))
        controller.tick()
        assert driver.started == []

    def test_finish_with_report(self, chat, ctl, routine):
        run = start_run(chat, ctl, routine)
        assert run.finish("# 今日要闻\n\n内容", "已发送今日要闻").status_code == 200
        # The runtime then exits; its own word does not override.
        run.complete(message="最后一句")
        shown = chat.get("/routines").json()["routines"][0]
        assert shown["runs"][0] | {"feedback": None} == shown["runs"][0] | {
            "status": "sent",
            "title": "今日要闻",
            "report": "# 今日要闻\n\n内容",
            "feedback": None,
        }
        assert shown["handoff"]["text"] == "已发送今日要闻"

    def test_nothing_new(self, chat, ctl, routine):
        run = start_run(chat, ctl, routine)
        run.finish(None, "源没有更新")
        assert RoutineRun.objects.get().status == "nothing_new"

    def test_without_finish_the_last_message_is_the_report(
        self,
        chat,
        ctl,
        routine,
    ):
        run = start_run(chat, ctl, routine)
        run.complete(message="# 报告\n正文")
        assert RoutineRun.objects.get().report == "# 报告\n正文"
        failed = start_run(chat, ctl, routine)
        failed.complete(completed=False, error="Codex 退出")
        assert RoutineRun.objects.get(pk=failed.run.pk).error == "Codex 退出"

    def test_next_run_gets_the_handoff(self, chat, ctl, routine):
        _, driver = ctl
        start_run(chat, ctl, routine).finish("# 一", "下次看看 RFC 结果")
        ctl[0].tick()  # removes the finished run's container
        start_run(chat, ctl, routine)
        settings = json.loads(driver.started[-1].env["AXP_CODEX_SETTINGS"])
        assert "下次看看 RFC 结果" in settings["developer_instructions"]

    def test_history_is_the_routines_own(self, chat, ctl, routine):
        first = start_run(chat, ctl, routine)
        first.finish("# 第一份\n提到了 Rust 2027", "交接一")
        ctl[0].tick()
        other = chat.post("/routines", {**NEWS, "name": "别的"}).json()
        start_run(chat, ctl, other).finish("# 别的报告", "")
        current = start_run(chat, ctl, routine)
        listed = current.call("get", "runs").json()
        assert [r["title"] for r in listed] == ["第一份"]
        found = current.call("get", "runs?q=Rust").json()
        assert [r["id"] for r in found] == [str(first.run.pk)]
        assert current.call("get", "runs?q=别的").json() == []
        full = current.call("get", f"runs/{first.run.pk}").json()
        assert full["report"].startswith("# 第一份")
        foreign = RoutineRun.objects.get(routine_id=other["id"])
        assert current.call("get", f"runs/{foreign.pk}").status_code == 404

    def test_token_is_the_runs_own_and_ends_with_it(
        self,
        chat,
        ctl,
        routine,
    ):
        run = start_run(chat, ctl, routine)
        assert run.call("get", "runs", token="x").status_code == 403
        key = f"{run.run.pk}.{run.token}"
        auth = internal("get", "runtime-auth", key)
        assert auth["X-AXP-Agent-Id"] == f"routine-{routine['id']}"
        run.finish(None)
        ctl[0].tick()
        assert run.call("get", "runs").status_code == 403
        assert internal("get", "runtime-auth", key).status_code == 403

    def test_watch(self, chat, ctl, routine):
        controller, driver = ctl
        run = start_run(chat, ctl, routine)
        container = RoutineRun.objects.get().container_id
        driver.states[container] = "exited"
        controller.tick()  # within the grace period: it may still report
        assert RoutineRun.objects.get().status == "running"
        RoutineRun.objects.update(started_at=timezone.now() - timedelta(minutes=1))
        controller.tick()
        failed = RoutineRun.objects.get(pk=run.run.pk)
        assert (failed.status, failed.error) == ("failed", "运行意外结束。")
        assert container in driver.stopped
        assert failed.container_id is None

    def test_time_limit(self, chat, ctl, routine):
        start_run(chat, ctl, routine)
        RoutineRun.objects.update(started_at=timezone.now() - timedelta(hours=1))
        ctl[0].tick()
        assert RoutineRun.objects.get().error == "运行超过 15 分钟，已停止。"

    def test_delete_waits_for_the_runtime(self, chat, ctl, routine):
        start_run(chat, ctl, routine)
        response = chat.delete(f"/routines/{routine['id']}")
        assert error_of(response) == (409, "ROUTINE_RUNNING")


class TestFeedback:
    @pytest.fixture
    def report(self, chat, ctl, routine):
        run = start_run(chat, ctl, routine)
        run.finish("# 日报\n体育新闻……", "交接")
        return run.run

    def revise(self, monkeypatch):
        # In this thread: the test's transaction is not committed.
        monkeypatch.setattr(runner, "_in_background", lambda f, *args: f(*args))
        runner.revise_briefs()

    def test_feedback_revises_the_brief(self, chat, routine, report, monkeypatch):
        path = f"/routines/{routine['id']}/runs/{report.pk}/feedback"
        sent = chat.post(path, {"text": "别放体育新闻"})
        assert sent.status_code == 201
        assert sent.json()["brief_version"] is None
        with mock.patch.object(runner, "_complete", return_value="新要求") as llm:
            self.revise(monkeypatch)
        prompt = llm.call_args.args[1]
        assert "别放体育新闻" in prompt
        assert "体育新闻……" in prompt
        brief = RoutineBrief.objects.get(version=2)
        assert (brief.text, brief.feedback.text) == ("新要求", "别放体育新闻")
        shown = chat.get("/routines").json()["routines"][0]
        assert shown["briefs"][0]["feedback"] == "别放体育新闻"
        assert shown["runs"][0]["feedback"][0]["brief_version"] == 2

    def test_failed_revision_is_marked(self, chat, routine, report, monkeypatch):
        chat.post(
            f"/routines/{routine['id']}/runs/{report.pk}/feedback", {"text": "短一点"}
        )
        with mock.patch.object(runner, "_complete", side_effect=OSError("down")):
            self.revise(monkeypatch)
        assert RoutineFeedback.objects.get().revision_failed is True
        assert RoutineBrief.objects.count() == 1
