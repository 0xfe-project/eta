# eta-goal

The goal state machine and self-continuation driver.

Tracks an objective across turns, re-injects a "continue working toward the
goal" reminder into the context, and applies an anti-spin guard that pauses the
goal after repeated idle turns.

Pure logic built on top of `eta-agent`; no I/O.
