/**
 * Which runtime this process is, and whether it can host the Node execution adapter.
 *
 * The adapter is built on `node:fs` and `node:child_process`. `std-env`'s `isNode` is true on
 * Node itself and in Bun's and Deno's Node-compatibility modes — exactly the runtimes where
 * those built-ins exist. On a runtime without them (workerd, a browser) there is no adapter
 * here, so a host that asks gets `undefined` and assembles a session with no file or shell
 * tools rather than one that fails at the first command.
 */
import { isNode } from "std-env";
import { NodeEnvironment } from "./node-shell";

/** Whether this runtime can host the Node execution adapter. */
export function supportsNodeExecution(): boolean {
	return isNode;
}

/** A local execution environment rooted at `cwd`, or `undefined` when the runtime cannot host one. */
export function createLocalEnvironment(cwd: string): NodeEnvironment | undefined {
	return isNode ? new NodeEnvironment({ cwd }) : undefined;
}
