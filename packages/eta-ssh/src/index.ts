/**
 * @eta/ssh — the harness's execution environment, on another machine.
 *
 * The rule this package exists to follow (REFACTOR.md §5, memory: SSH is a plugin,
 * not harness): the harness owns the *seam* (`ExecutionEnv`: a filesystem and a
 * shell, in harness vocabulary, with backend-independent error codes), and a
 * backend that needs a network lives out here. The tools a session runs are the
 * same tools either way — they were written against the seam, so `read`, `write`,
 * `edit`, `bash` and everything built on them work unchanged against a machine
 * across the room.
 */
export {
	SshEnvironment,
	type SshEnvironmentOptions,
} from "./env";
export { LocalTransport, type LocalTransportOptions } from "./local-transport";
export {
	hostKeyFingerprint,
	type SpawnLike,
	SshCommandTransport,
	type SshCommandTransportOptions,
	type SshResult,
	type SshRunOptions,
	type SshStreamEvent,
	type SshTarget,
	type SshTransport,
	shellQuote,
	sshArgs,
	validHost,
} from "./transport";
