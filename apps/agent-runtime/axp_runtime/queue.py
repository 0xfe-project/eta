"""The agent's queue (NATS JetStream; apps/control-plane/chat/queue.py).

``take()`` gives the runtime the next command from ``axp.agent.<agent>.commands``,
already acked: from then on it is the runtime's alone, and a crash loses it
rather than running it twice. Control messages on ``axp.agent.<agent>.control``
go to ``handle(body)``, whose result is the reply.
"""

import asyncio
import json
import logging
import threading
import time

import nats
from nats.errors import TimeoutError as NatsTimeout

from .config import Settings

logger = logging.getLogger(__name__)

STREAM = "AGENTS"
TAKE_SECONDS = 1


class AgentQueue:
    def __init__(self, settings: Settings, handle):
        self.settings = settings
        self.handle = handle
        self._loop = asyncio.new_event_loop()
        self._nc = None
        self._commands = None

    def start(self) -> None:
        threading.Thread(
            target=self._loop.run_forever, name="nats", daemon=True
        ).start()

    def stop(self) -> None:
        if self._nc is not None:
            try:
                self._run(self._nc.close(), 2)
            except Exception:
                pass
        self._loop.call_soon_threadsafe(self._loop.stop)

    def _run(self, coroutine, timeout: float):
        return asyncio.run_coroutine_threadsafe(coroutine, self._loop).result(timeout)

    async def _connect(self) -> None:
        agent = self.settings.agent_id
        self._nc = await nats.connect(
            self.settings.nats_url,
            name=f"agent-{agent}",
            max_reconnect_attempts=-1,
        )
        await self._nc.subscribe(f"axp.agent.{agent}.control", cb=self._control)
        self._commands = await self._nc.jetstream().pull_subscribe_bind(
            f"agent-{agent}", stream=STREAM
        )

    async def _control(self, message) -> None:
        try:
            body = json.loads(message.data)
            # Off the loop: steering waits on Codex.
            reply = await self._loop.run_in_executor(None, self.handle, body)
        except Exception:
            logger.exception("Control message failed")
            reply = {}
        if message.reply:
            await message.respond(json.dumps(reply).encode())

    def take(self) -> dict | None:
        """The next command, or None after waiting a second for one."""
        try:
            if self._commands is None:
                self._run(self._connect(), 15)
            [message] = self._run(
                self._commands.fetch(1, timeout=TAKE_SECONDS), TAKE_SECONDS + 5
            )
            self._run(message.ack_sync(), 10)
        except NatsTimeout:
            return None
        except Exception as exc:
            # Unacked, it is delivered again.
            logger.warning("Taking from the agent queue failed: %s", exc)
            time.sleep(TAKE_SECONDS)
            return None
        try:
            return json.loads(message.data)
        except ValueError:
            logger.warning("Dropping a malformed command")
            return None
