# eta-context

The `ContextPlugin` contract.

A context plugin renders a static block of "meta" context — workspace identity,
skills catalog, memory, user info — into the system prompt.

Ships only the trait; concrete plugins are provided by the embedder or by
adapter crates.
