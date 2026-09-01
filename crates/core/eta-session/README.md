# eta-session

Session management & persistence.

Implements `SessionStorage` (the trait is defined in `eta-core`) plus context
assembly (progressive disclosure, `build_context`) and git-like time travel
(fork / commit / checkout / rollback / merge / search).

Storage backends are implemented in adapters (e.g. `eta-sqlite-storage`).
