from datetime import timedelta

import pytest
from django.utils import timezone

from chat.fake_runtime import FakeRuntime
from chat.models import AgentCommand, Interaction, UiEvent

from .helpers import assert_no_internal_fields

pytestmark = pytest.mark.django_db


@pytest.fixture
def runtime():
    return FakeRuntime("w1", step_delay=0)


@pytest.fixture
def run_next(runtime):
    def run():
        command_id = runtime.claim()
        assert command_id is not None
        runtime.execute(command_id)
        return command_id

    return run


def reply_of(chat, sent):
    reply_id = sent["reply"]["id"]
    return next(m for m in chat.get("/chat").json()["messages"] if m["id"] == reply_id)


def expire_claim(command_id):
    AgentCommand.objects.filter(pk=command_id).update(
        claim_until=timezone.now() - timedelta(seconds=1)
    )


def test_reply_completes_and_agent_returns_idle(chat, agent, run_next):
    sent = chat.send(agent["id"], "你好")
    run_next()
    reply = reply_of(chat, sent)
    assert reply["status"] == "completed"
    assert "你好" in reply["blocks"][-1]["text"]
    assert reply["blocks"][0]["status"] == "completed"
    snapshot = chat.get("/chat").json()
    assert snapshot["agents"][0]["status"] == "idle"
    assert snapshot["active_replies"] == []
    # Revisions only grow, and every event is a public projection.
    revisions = [
        e.payload["message"]["revision"]
        for e in UiEvent.objects.filter(type="message.updated").order_by("seq")
        if e.payload["message"]["id"] == reply["id"]
    ]
    assert revisions == sorted(set(revisions))
    for event in UiEvent.objects.all():
        assert_no_internal_fields(event.payload)


def test_same_agent_is_serial_and_fifo(chat, agent, runtime):
    first = chat.send(agent["id"], "one")
    chat.send(agent["id"], "two")
    claimed = runtime.claim()
    assert AgentCommand.objects.get(pk=claimed).input["text"] == "one"
    assert runtime.claim() is None
    runtime.execute(claimed)
    assert reply_of(chat, first)["status"] == "completed"
    assert runtime.claim() is not None


def test_different_agents_run_in_parallel(chat, agent, runtime):
    other = chat.create_agent("另一个")
    chat.send(agent["id"])
    chat.send(other["id"])
    assert runtime.claim() is not None
    assert runtime.claim() is not None
    assert AgentCommand.objects.filter(status="dispatching").count() == 2


def test_choice_interaction_round_trip(chat, agent, runtime, run_next):
    sent = chat.send(agent["id"], "请确认后执行")
    run_next()
    snapshot = chat.get("/chat").json()
    assert snapshot["agents"][0]["status"] == "waiting_for_input"
    [interaction] = snapshot["interactions"]
    assert interaction["status"] == "pending"
    assert interaction["message_id"] == sent["reply"]["id"]
    assert_no_internal_fields(interaction)
    # Waiting does not hold a worker, and nothing is claimable yet.
    assert runtime.claim() is None

    path = f"/chat/interactions/{interaction['id']}/answer"
    assert chat.post(path, {"value": "maybe"}).status_code == 422
    answered = chat.post(path, {"value": "allow"})
    assert answered.status_code == 202
    assert answered.json()["status"] == "submitted"
    assert chat.post(path, {"value": "allow"}).status_code == 202
    assert chat.post(path, {"value": "deny"}).status_code == 409

    run_next()
    assert Interaction.objects.get().status == "resolved"
    reply = reply_of(chat, sent)
    assert reply["status"] == "completed"
    assert "请确认后执行" in reply["blocks"][-1]["text"]
    assert chat.get("/chat").json()["interactions"] == []


def test_stop_while_responding_is_confirmed_by_runtime(chat, agent, runtime):
    sent = chat.send(agent["id"])
    command_id = runtime.claim()
    runtime._write(command_id, runtime._start)
    stopping = chat.post(f"/chat/messages/{sent['reply']['id']}/stop").json()
    assert stopping["status"] == "stopping"
    runtime.execute(command_id)
    assert reply_of(chat, sent)["status"] == "stopped"
    assert AgentCommand.objects.get().status == "interrupted"
    assert chat.get("/chat").json()["agents"][0]["status"] == "idle"


def test_stop_while_waiting_expires_interaction(chat, agent, run_next):
    sent = chat.send(agent["id"], "确认")
    run_next()
    chat.post(f"/chat/messages/{sent['reply']['id']}/stop")
    interaction = Interaction.objects.get()
    assert interaction.status == "expired"
    late = chat.post(f"/chat/interactions/{interaction.id}/answer", {"value": "allow"})
    assert late.status_code == 409
    run_next()
    assert reply_of(chat, sent)["status"] == "stopped"


def test_lost_worker_never_replays_started_turn(chat, agent, runtime):
    sent = chat.send(agent["id"])
    command_id = runtime.claim()
    runtime._write(command_id, runtime._start)
    expire_claim(command_id)
    FakeRuntime("w2", step_delay=0).reconcile_expired_leases()
    reply = reply_of(chat, sent)
    assert reply["status"] == "failed"
    assert reply["failure"]["code"] == "REPLY_INTERRUPTED"
    command = AgentCommand.objects.get()
    assert (command.status, command.attempt_count) == ("failed", 1)
    # The old worker is fenced off.
    runtime.execute(command_id)
    assert reply_of(chat, sent)["status"] == "failed"


def test_unsent_dispatch_is_requeued(chat, agent, runtime):
    chat.send(agent["id"])
    command_id = runtime.claim()
    expire_claim(command_id)
    runtime.reconcile_expired_leases()
    assert AgentCommand.objects.get().status == "queued"
    assert runtime.claim() == command_id
