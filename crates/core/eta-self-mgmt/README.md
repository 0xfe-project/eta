# eta-self-mgmt

Self-monitoring for the agent.

- loop detection: stop the turn when the model repeats itself;
- self-summary: compact long context through a `Provider` call.

Pure logic built on `eta-agent`; no I/O.
