/**
 * External agent runtimes, as the session host sees them.
 *
 * A session runs on eta's own loop unless its metadata names a `runtime` (Claude Code, Codex,
 * ...). Then the manager asks the host's runtimes for that one, and the session's runs are
 * delegated to it (`RunDelegate` in the kernel): the session stays an eta session, with its
 * journal, its bus, its inbox and its place in every list, and the runtime is what answers.
 *
 * The manager does not know what a runtime is or how it is reached; it knows the shape below. A
 * host that supplies none simply cannot open such a session, and says so.
 */
import type { KernelModels, RunDelegate } from "@eta/core";

export interface SessionRuntimeInput {
  /** The eta session whose runs this takes. */
  sessionId: string;
  /** Which runtime (`claude`, `codex`, ...). */
  runtime: string;
  /** The project the session works in. */
  cwd: string;
  /** The runtime's own session to pick up, when this one has run before. */
  resume?: string | undefined;
  /**
   * Who the agent is, what it was told and what the app around it is: what stands in for an eta
   * session's platform section. Read when the runtime opens, after the session's tools exist,
   * because what it says about the board depends on them.
   */
  agentPrompt: () => string | undefined;
  /** The runtime opened a session of its own: remember it, so the next open picks it up. */
  remember: (nativeSession: string) => void;
  /**
   * The tools the host gave this session, by name: what the runtime is offered beyond its own
   * (a task board, a way to reach other agents). Read when the runtime opens, after they exist.
   */
  hostTools: () => readonly string[];
}

export interface SessionRuntime {
  /**
   * What the session's model resolves against: the runtime's own models, as
   * `runtime:modelId`. Only `getModel` is asked; the runtime generates, not eta.
   */
  models: KernelModels;
  delegate: RunDelegate;
  /** Let the runtime go: its process, and anything it served for the session. */
  dispose: () => Promise<void>;
}

export interface SessionRuntimes {
  /** The runtime for one session; `undefined` when this host does not run that one. */
  open: (input: SessionRuntimeInput) => SessionRuntime | undefined;
}
