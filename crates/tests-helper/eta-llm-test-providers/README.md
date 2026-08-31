# eta-llm-test-providers

Mock / fake `Provider` implementations for unit tests.

Pulled as a dev-dependency to exercise the agent loop without real network
I/O: parent/child subagents, tool-call failures, streaming edge cases, cache
accounting, and so on.
