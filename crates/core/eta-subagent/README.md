# eta-subagent

Recursive, typed subagent orchestration.

Spawns full nested `Agent`s through the embedder-supplied `Spawner`, with
background / parallel / interrupt semantics, and hands the result back to the
parent as a single tool result.

Pure orchestration logic; the spawned agents do their I/O through tools that
live in adapter crates.
