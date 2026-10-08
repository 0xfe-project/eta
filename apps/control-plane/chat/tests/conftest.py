from unittest import mock

import pytest

from chat import llm, queue

from .helpers import TEST_MODEL, ChatClient


class FakeQueue:
    """Stands in for NATS: the agents' queues and their live runtimes."""

    def __init__(self):
        self.commands: dict[int, tuple[str, dict]] = {}
        self.seq = 0
        self.consumers = []
        self.forgotten = []
        self.told = []
        self.asked = []
        # Whether a running turn takes steers.
        self.steering = False
        self.down = False
        # Routine id -> (cron, timezone).
        self.schedules: dict[str, tuple[str, str]] = {}
        self.fires: list[tuple[str, bool]] = []

    def enqueue(self, agent_id, body):
        if self.down:
            raise ConnectionError("nats down")
        if len(self.queued(agent_id)) >= queue.MAX_QUEUED_PER_AGENT:
            raise queue.QueueFull
        self.seq += 1
        self.commands[self.seq] = (str(agent_id), body)
        return self.seq

    def withdraw(self, seq):
        return self.commands.pop(seq, None) is not None

    def waiting(self, seq):
        return seq in self.commands

    def agents_with_commands(self):
        return {agent_id for agent_id, _ in self.commands.values()}

    def open_consumer(self, agent_id):
        self.consumers.append(str(agent_id))

    def drop(self, agent_id):
        for seq, (owner, _) in list(self.commands.items()):
            if owner == str(agent_id):
                del self.commands[seq]

    def forget(self, agent_id):
        self.drop(agent_id)
        self.forgotten.append(str(agent_id))

    def tell(self, agent_id, body):
        self.told.append(body)

    def ask(self, agent_id, body):
        self.asked.append(body)
        return {"accepted": self.steering}

    def schedule_routine(self, routine_id, cron, timezone):
        if self.down:
            raise ConnectionError("nats down")
        self.schedules[str(routine_id)] = (cron, timezone)

    def unschedule_routine(self, routine_id):
        self.schedules.pop(str(routine_id), None)

    def fire_routine(self, routine_id):
        self.fires.append((str(routine_id), True))

    def take_fires(self):
        fires, self.fires = self.fires, []
        return fires

    # --- for tests ------------------------------------------------------

    def queued(self, agent_id):
        return [
            body for owner, body in self.commands.values() if owner == str(agent_id)
        ]

    def take(self, agent_id):
        """What the agent's runtime does: take the next command."""
        seq = min(
            s for s, (owner, _) in self.commands.items() if owner == str(agent_id)
        )
        return self.commands.pop(seq)[1]

    def told_of(self, type_):
        return [
            {k: v for k, v in body.items() if k != "type"}
            for body in self.told
            if body["type"] == type_
        ]


@pytest.fixture(autouse=True)
def llm_catalog(monkeypatch):
    """Every chat goes through the LLM gateway; offer one available model.

    The catalog is fetched on every use, so tests see changes immediately.
    """
    monkeypatch.setattr(llm, "CACHE_SECONDS", 0)
    catalog = {
        TEST_MODEL: llm.Model(
            id=TEST_MODEL,
            connector="test",
            display_name="Test Model",
            context_window=None,
            available=True,
            unavailable_message=None,
        )
    }
    with mock.patch("chat.llm._fetch", return_value=catalog):
        yield


@pytest.fixture(autouse=True)
def nats(monkeypatch):
    fake = FakeQueue()
    for name in (
        "enqueue",
        "withdraw",
        "waiting",
        "agents_with_commands",
        "open_consumer",
        "drop",
        "forget",
        "tell",
        "ask",
        "schedule_routine",
        "unschedule_routine",
        "fire_routine",
        "take_fires",
    ):
        monkeypatch.setattr(queue, name, getattr(fake, name))
    return fake


@pytest.fixture
def chat():
    return ChatClient()


@pytest.fixture
def agent(chat):
    return chat.create_agent()
