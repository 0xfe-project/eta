from datetime import timedelta

from django.test import TestCase
from django.utils import timezone

from chat.fake_runtime import FakeRuntime
from chat.models import AgentCommand, Interaction, UiEvent

from .helpers import ChatClient, assert_no_internal_fields


class FakeRuntimeTests(TestCase):
    def setUp(self):
        self.chat = ChatClient()
        self.agent = self.chat.create_agent()
        self.runtime = FakeRuntime("w1", step_delay=0)

    def snapshot(self):
        return self.chat.get("/chat").json()

    def reply(self, reply_id):
        return next(m for m in self.snapshot()["messages"] if m["id"] == reply_id)

    def run_next(self):
        command_id = self.runtime.claim()
        self.assertIsNotNone(command_id)
        self.runtime.execute(command_id)
        return command_id

    def test_reply_completes_and_agent_returns_idle(self):
        sent = self.chat.send(self.agent["id"], "你好")
        self.run_next()
        reply = self.reply(sent["reply"]["id"])
        self.assertEqual(reply["status"], "completed")
        self.assertIn("你好", reply["blocks"][-1]["text"])
        self.assertEqual(reply["blocks"][0]["status"], "completed")
        snapshot = self.snapshot()
        self.assertEqual(snapshot["agents"][0]["status"], "idle")
        self.assertEqual(snapshot["active_replies"], [])
        # Revisions only grow, and every event is a public projection.
        revisions = [
            e.payload["message"]["revision"]
            for e in UiEvent.objects.filter(type="message.updated").order_by("seq")
            if e.payload["message"]["id"] == reply["id"]
        ]
        self.assertEqual(revisions, sorted(set(revisions)))
        for event in UiEvent.objects.all():
            assert_no_internal_fields(self, event.payload)

    def test_same_agent_is_serial_and_fifo(self):
        first = self.chat.send(self.agent["id"], "one")
        self.chat.send(self.agent["id"], "two")
        claimed = self.runtime.claim()
        self.assertEqual(AgentCommand.objects.get(pk=claimed).input["text"], "one")
        self.assertIsNone(self.runtime.claim())
        self.runtime.execute(claimed)
        self.assertEqual(self.reply(first["reply"]["id"])["status"], "completed")
        self.assertIsNotNone(self.runtime.claim())

    def test_different_agents_run_in_parallel(self):
        other = self.chat.create_agent("另一个")
        self.chat.send(self.agent["id"])
        self.chat.send(other["id"])
        self.assertIsNotNone(self.runtime.claim())
        self.assertIsNotNone(self.runtime.claim())
        self.assertEqual(AgentCommand.objects.filter(status="dispatching").count(), 2)

    def test_choice_interaction_round_trip(self):
        sent = self.chat.send(self.agent["id"], "请确认后执行")
        self.run_next()
        snapshot = self.snapshot()
        self.assertEqual(snapshot["agents"][0]["status"], "waiting_for_input")
        [interaction] = snapshot["interactions"]
        self.assertEqual(interaction["status"], "pending")
        self.assertEqual(interaction["message_id"], sent["reply"]["id"])
        assert_no_internal_fields(self, interaction)
        # Waiting does not hold a worker, and nothing is claimable yet.
        self.assertIsNone(self.runtime.claim())

        path = f"/chat/interactions/{interaction['id']}/answer"
        self.assertEqual(self.chat.post(path, {"value": "maybe"}).status_code, 422)
        answered = self.chat.post(path, {"value": "allow"})
        self.assertEqual(answered.status_code, 202)
        self.assertEqual(answered.json()["status"], "submitted")
        self.assertEqual(self.chat.post(path, {"value": "allow"}).status_code, 202)
        conflict = self.chat.post(path, {"value": "deny"})
        self.assertEqual(conflict.status_code, 409)

        self.run_next()
        self.assertEqual(Interaction.objects.get().status, "resolved")
        reply = self.reply(sent["reply"]["id"])
        self.assertEqual(reply["status"], "completed")
        self.assertIn("请确认后执行", reply["blocks"][-1]["text"])
        self.assertEqual(self.snapshot()["interactions"], [])

    def test_stop_while_responding_is_confirmed_by_runtime(self):
        sent = self.chat.send(self.agent["id"])
        command_id = self.runtime.claim()
        self.runtime._write(command_id, self.runtime._start)
        reply_id = sent["reply"]["id"]
        stopping = self.chat.post(f"/chat/messages/{reply_id}/stop").json()
        self.assertEqual(stopping["status"], "stopping")
        self.runtime.execute(command_id)
        reply = self.reply(reply_id)
        self.assertEqual(reply["status"], "stopped")
        self.assertEqual(AgentCommand.objects.get().status, "interrupted")
        self.assertEqual(self.snapshot()["agents"][0]["status"], "idle")

    def test_stop_while_waiting_expires_interaction(self):
        sent = self.chat.send(self.agent["id"], "确认")
        self.run_next()
        reply_id = sent["reply"]["id"]
        self.chat.post(f"/chat/messages/{reply_id}/stop")
        self.assertEqual(Interaction.objects.get().status, "expired")
        interaction_id = Interaction.objects.get().id
        late = self.chat.post(
            f"/chat/interactions/{interaction_id}/answer", {"value": "allow"}
        )
        self.assertEqual(late.status_code, 409)
        self.run_next()
        self.assertEqual(self.reply(reply_id)["status"], "stopped")

    def test_lost_worker_never_replays_started_turn(self):
        sent = self.chat.send(self.agent["id"])
        command_id = self.runtime.claim()
        self.runtime._write(command_id, self.runtime._start)
        AgentCommand.objects.filter(pk=command_id).update(
            claim_until=timezone.now() - timedelta(seconds=1)
        )
        FakeRuntime("w2", step_delay=0).reconcile_expired_leases()
        reply = self.reply(sent["reply"]["id"])
        self.assertEqual(reply["status"], "failed")
        self.assertEqual(reply["failure"]["code"], "REPLY_INTERRUPTED")
        command = AgentCommand.objects.get()
        self.assertEqual(command.status, "failed")
        self.assertEqual(command.attempt_count, 1)
        # The old worker is fenced off.
        self.runtime.execute(command_id)
        self.assertEqual(self.reply(sent["reply"]["id"])["status"], "failed")

    def test_unsent_dispatch_is_requeued(self):
        self.chat.send(self.agent["id"])
        command_id = self.runtime.claim()
        AgentCommand.objects.filter(pk=command_id).update(
            claim_until=timezone.now() - timedelta(seconds=1)
        )
        self.runtime.reconcile_expired_leases()
        self.assertEqual(AgentCommand.objects.get().status, "queued")
        self.assertEqual(self.runtime.claim(), command_id)
