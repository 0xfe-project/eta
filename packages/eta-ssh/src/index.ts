/**
 * @eta/ssh — run a shell script on another machine (or this one) and quote safely for it.
 *
 * Only the transport is left: the `ExecutionEnv` over SSH went away with `@eta/execution`
 * (see packages/TOBEREFR/TODO.md). Task worktrees, project files and remote machines still
 * use the transport to run `sh` on the right host.
 */
export { LocalTransport, type LocalTransportOptions } from "./local-transport";
export {
  hostKeyFingerprint,
  shellQuote,
  type SpawnLike,
  sshArgs,
  SshCommandTransport,
  type SshCommandTransportOptions,
  type SshResult,
  type SshRunOptions,
  type SshStreamEvent,
  type SshTarget,
  type SshTransport,
  validHost,
} from "./transport";
