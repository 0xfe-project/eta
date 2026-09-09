# UPSTREAM

- fork: pi-agent-core v0.85.1 (MIT), upstream commit in `refs` pi checkout `acaa253cc8e3f159e6100b6f3874861b1f0bfc99
- import commit: see git log "M0"
- rename codemod: `@earendil-works/pi-agent-core` -> `@eta/core` only; dependency scopes
  (`@earendil-works/pi-ai`, `pi-telemetry`, `chord`) untouched
- sync policy: 3-way merge against upstream release tarballs; keep directory layout
