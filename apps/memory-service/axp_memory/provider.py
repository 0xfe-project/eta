"""What the service needs from a memory backend.

mem0 is the first provider. Another backend implements these four methods;
existing memories move over by listing them from the old one and adding them
to the new one without inference.
"""

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class Memory:
    id: str
    text: str
    # Relevance to the query, for search results.
    score: float | None = None
    # ISO 8601, when the provider records it.
    created_at: str | None = None
    # How it came to be remembered: "conversation" (extracted from a finished
    # turn), "agent" (the agent's remember tool) or "user" (added by the
    # user). None for memories from before sources were recorded.
    source: str | None = None


class MemoryProvider(Protocol):
    def add(
        self,
        agent_id: str,
        messages: list[dict],
        *,
        source: str,
        infer: bool,
        model: str | None = None,
    ) -> list[Memory]:
        """Remember ``messages`` ({"role", "content"}) for the agent.

        With ``infer`` the provider extracts facts with ``model``; without it
        every message is kept as written. Every memory keeps ``source``.
        """
        ...

    def search(
        self, agent_id: str, query: str, limit: int, *, source: str | None = None
    ) -> list[Memory]: ...

    def list(self, agent_id: str, *, source: str | None = None) -> list[Memory]: ...

    def delete(self, agent_id: str, memory_id: str) -> bool:
        """Forget one of the agent's memories; False if it has no such one."""
        ...
