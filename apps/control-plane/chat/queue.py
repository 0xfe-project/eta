"""The agent queue: NATS JetStream (docs/architecture/queue.md).

This is the only queue. A command waiting to run is a message on its agent's
subject ``axp.agent.<agent>.commands``; PostgreSQL records what happened to
it, never whether it waits. The agent's runtime takes one message at a time
through the consumer ``agent-<agent>``, acks it and runs it.

The live runtime also listens on ``axp.agent.<agent>.control`` (plain NATS,
not stored): interrupts, approval decisions and steers go there.
"""

import asyncio
import json
import threading

import nats
from django.conf import settings
from nats.errors import NoRespondersError
from nats.errors import TimeoutError as NatsTimeout
from nats.js.api import (
    AckPolicy,
    ConsumerConfig,
    DiscardPolicy,
    RetentionPolicy,
    StorageType,
    StreamConfig,
)
from nats.js.errors import APIError, NotFoundError

STREAM = "AGENTS"
MAX_QUEUED_PER_AGENT = 20
TIMEOUT_SECONDS = 5
STREAM_CONFIG = StreamConfig(
    name=STREAM,
    subjects=["axp.agent.*.commands"],
    # A message stays until a runtime takes it.
    retention=RetentionPolicy.WORK_QUEUE,
    storage=StorageType.FILE,
    # A full agent queue refuses new commands.
    max_msgs_per_subject=MAX_QUEUED_PER_AGENT,
    discard=DiscardPolicy.NEW,
    discard_new_per_subject=True,
)
# A runtime acks a command as soon as it takes it; this only matters if it
# dies in between.
ACK_WAIT_SECONDS = 30


class QueueFull(Exception):
    pass


def commands_subject(agent_id) -> str:
    return f"axp.agent.{agent_id}.commands"


def control_subject(agent_id) -> str:
    return f"axp.agent.{agent_id}.control"


def consumer_name(agent_id) -> str:
    return f"agent-{agent_id}"


class _Connection:
    """One NATS connection per process, on a private event loop thread."""

    def __init__(self):
        self._lock = threading.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._nc = None
        self._connecting = asyncio.Lock()

    def run(self, make_coroutine):
        """Run ``make_coroutine(nc)`` on the loop and wait for it."""
        with self._lock:
            if self._loop is None:
                self._loop = asyncio.new_event_loop()
                threading.Thread(
                    target=self._loop.run_forever, name="nats", daemon=True
                ).start()
        return asyncio.run_coroutine_threadsafe(
            self._call(make_coroutine), self._loop
        ).result(TIMEOUT_SECONDS * 2)

    async def _call(self, make_coroutine):
        async with self._connecting:
            if self._nc is None or self._nc.is_closed:
                # A failed first connect raises; the next call tries again.
                self._nc = await nats.connect(
                    settings.AXP_NATS_URL,
                    name="control-plane",
                    connect_timeout=TIMEOUT_SECONDS,
                    max_reconnect_attempts=-1,
                )
        return await make_coroutine(self._nc)


_connection = _Connection()


def _js(make_coroutine):
    return _connection.run(
        lambda nc: make_coroutine(nc.jetstream(timeout=TIMEOUT_SECONDS))
    )


def ensure_stream() -> None:
    async def ensure(js):
        try:
            await js.stream_info(STREAM)
        except NotFoundError:
            await js.add_stream(STREAM_CONFIG)
        else:
            await js.update_stream(STREAM_CONFIG)

    _js(ensure)


def enqueue(agent_id, body: dict) -> int:
    """Queue a command; returns its stream sequence."""
    data = json.dumps(body).encode()
    try:
        ack = _js(lambda js: js.publish(commands_subject(agent_id), data))
    except APIError as exc:
        if exc.err_code == 10077:  # maximum messages per subject exceeded
            raise QueueFull from exc
        raise
    return ack.seq


def withdraw(seq: int) -> bool:
    """Take a command off the queue; False if a runtime already took it."""

    async def delete(js):
        try:
            return await js.delete_msg(STREAM, seq)
        except NotFoundError:
            return False

    return _js(delete)


def waiting(seq: int) -> bool:
    """Whether a command is still in the queue."""

    async def get(js):
        try:
            await js.get_msg(STREAM, seq)
        except NotFoundError:
            return False
        return True

    return _js(get)


def agents_with_commands() -> set[str]:
    async def subjects(js):
        info = await js.stream_info(STREAM, subjects_filter="axp.agent.*.commands")
        return info.state.subjects or {}

    return {subject.split(".")[2] for subject in _js(subjects)}


def open_consumer(agent_id) -> None:
    """The agent's consumer; its runtime reads the queue through it."""
    config = ConsumerConfig(
        durable_name=consumer_name(agent_id),
        filter_subject=commands_subject(agent_id),
        ack_policy=AckPolicy.EXPLICIT,
        ack_wait=ACK_WAIT_SECONDS,
    )
    _js(lambda js: js.add_consumer(STREAM, config))


def drop(agent_id) -> None:
    """Empty the agent's queue."""
    _js(lambda js: js.purge_stream(STREAM, subject=commands_subject(agent_id)))


def forget(agent_id) -> None:
    """Drop a deleted agent's queue and consumer."""

    async def remove(js):
        await js.purge_stream(STREAM, subject=commands_subject(agent_id))
        try:
            await js.delete_consumer(STREAM, consumer_name(agent_id))
        except NotFoundError:
            pass

    _js(remove)


def tell(agent_id, body: dict) -> None:
    """Send the agent's live runtime a control message, if it listens."""
    data = json.dumps(body).encode()

    async def send(nc):
        await nc.publish(control_subject(agent_id), data)
        await nc.flush(TIMEOUT_SECONDS)

    _connection.run(send)


def ask(agent_id, body: dict) -> dict | None:
    """Ask the agent's live runtime; None when no runtime answers."""
    data = json.dumps(body).encode()

    async def request(nc):
        try:
            reply = await nc.request(
                control_subject(agent_id), data, timeout=TIMEOUT_SECONDS
            )
        except (NoRespondersError, NatsTimeout):
            return None
        return json.loads(reply.data)

    return _connection.run(request)
