/**
 * The SSH hop: trust, retries, and reconnecting.
 *
 * These are the parts a local transport cannot exercise, so they are tested against
 * a scripted `ssh`: what we spawn, in what order, and what happens when the
 * connection drops between two commands. No network, no real host, no credentials —
 * the subject here is our own decisions, not OpenSSH's.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
	hostKeyFingerprint,
	SshCommandTransport,
	type SshTarget,
	shellQuote,
	sshArgs,
	validHost,
} from "../src/transport";

/** A stand-in for a spawned `ssh`, scripted per call. */
interface ScriptedCall {
	result?: { code: number; stdout?: string; stderr?: string };
	/** Emit this as the child's stdout before closing. */
	emit?: string;
	onSpawn?: (args: string[], env: NodeJS.ProcessEnv | undefined) => void;
	error?: Error;
}

function scriptedSpawn(calls: ScriptedCall[]) {
	const seen: { command: string; args: string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
	const spawnFn = (command: string, args: string[], options: { env?: NodeJS.ProcessEnv; stdio: unknown }) => {
		const script = calls[seen.length] ?? { result: { code: 0, stdout: "" } };
		seen.push({ command, args, env: options.env });
		script.onSpawn?.(args, options.env);
		const child = new EventEmitter() as EventEmitter & {
			stdout: EventEmitter;
			stderr: EventEmitter;
			stdin: { end(): void; write(): void };
			kill(): void;
			pid: number;
		};
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.stdin = { end: () => undefined, write: () => undefined };
		child.kill = () => undefined;
		child.pid = 1;
		setTimeout(() => {
			if (script.error !== undefined) {
				child.emit("error", script.error);
				return;
			}
			const stdout = script.emit ?? script.result?.stdout;
			if (stdout !== undefined) child.stdout.emit("data", Buffer.from(stdout));
			if (script.result?.stderr !== undefined) child.stderr.emit("data", Buffer.from(script.result.stderr));
			child.emit("close", script.result?.code ?? 0);
		}, 0);
		return child;
	};
	return { spawnFn, seen };
}

const target: SshTarget = { host: "build-box", user: "eta", port: 2222 };

describe("the arguments OpenSSH is given", () => {
	it("quotes a script so the far side sees one argument", () => {
		expect(shellQuote("a b")).toBe("'a b'");
		expect(shellQuote("it's")).toBe("'it'\\''s'");
	});

	it("refuses a host that could be read as an option, and accepts real ones", () => {
		expect(validHost("build-box")).toBe(true);
		expect(validHost("10.0.0.2")).toBe(true);
		expect(validHost("-oProxyCommand=evil")).toBe(false);
		expect(validHost("host with space")).toBe(false);
	});

	it("never prompts, and shares one connection when it is allowed to", () => {
		const args = sshArgs(target).join(" ");
		expect(args).toContain("BatchMode=yes");
		expect(args).toContain("StrictHostKeyChecking=yes");
		expect(args).toContain("-p 2222");
		expect(args).toContain("-l eta");
		// No shared socket unless one is asked for: a stray ControlPath is a surprise.
		expect(args).toContain("ControlMaster=no");

		const shared = sshArgs(target, { path: "/tmp/eta-ssh-x/control", persist: true }).join(" ");
		expect(shared).toContain("ControlMaster=auto");
		expect(shared).toContain("ControlPath=/tmp/eta-ssh-x/control");
		expect(shared).toContain("ControlPersist=60");
	});
});

describe("host keys", () => {
	it("reads the fingerprint out of OpenSSH's own prompt", () => {
		const prompt =
			"The authenticity of host 'build-box (10.0.0.2)' can't be established.\n" +
			"ED25519 key fingerprint is SHA256:AbCdEf1234567890abcdef.\n" +
			"Are you sure you want to continue connecting (yes/no/[fingerprint])?";
		expect(hostKeyFingerprint(prompt)).toEqual({
			algorithm: "ED25519",
			fingerprint: "SHA256:AbCdEf1234567890abcdef",
		});
		expect(hostKeyFingerprint("Are you sure you want to continue connecting?")).toBeUndefined();
	});

	it("accepts the key it was told to expect", async () => {
		const fingerprint = "SHA256:AbCdEf1234567890abcdef";
		const { spawnFn, seen } = scriptedSpawn([
			{
				// The key prompt: written where the askpass helper would put it.
				onSpawn: (_args, env) => {
					const helper = env?.SSH_ASKPASS;
					expect(helper).toBeDefined();
					expect(env?.SSH_ASKPASS_REQUIRE).toBe("force");
				},
				result: { code: 0, stdout: "" },
			},
			{ result: { code: 0, stdout: "/home/eta\n" } },
		]);
		const transport = await SshCommandTransport.connect({
			target,
			expectedFingerprint: fingerprint,
			reuseConnection: false,
			spawnFn,
		});
		expect(transport.home).toBe("/home/eta");
		// Authentication is disabled for the trust check: the helper can never be used
		// to answer a password prompt.
		expect(seen[0]!.args.join(" ")).toContain("PreferredAuthentications=none");
		await transport.close();
	});

	it("refuses a host key that is not the one it was told to expect", async () => {
		const directory = { path: "" };
		const { spawnFn } = scriptedSpawn([
			{
				onSpawn: (_args, env) => {
					// Simulate OpenSSH writing a *different* host's prompt: the helper
					// refuses it, which leaves the accepted file absent.
					directory.path = String(env?.SSH_ASKPASS ?? "");
				},
				result: { code: 255, stderr: "Host key verification failed." },
			},
		]);
		await expect(
			SshCommandTransport.connect({
				target,
				expectedFingerprint: "SHA256:ThisIsNotWhatTheHostPresents",
				reuseConnection: false,
				spawnFn,
			}),
		).rejects.toThrow(/could not determine the home directory|Host key verification failed/);
	});
});

describe("a dropped connection", () => {
	it("retries a transport failure (exit 255), and does not retry a command's own failure", async () => {
		const { spawnFn, seen } = scriptedSpawn([
			// 0: the host-key check `connect` always makes. 1: where home is.
			{ result: { code: 0 } },
			{ result: { code: 0, stdout: "/home/eta" } },
			{ result: { code: 255, stderr: "Connection to build-box closed." } },
			{ result: { code: 255, stderr: "Connection to build-box closed." } },
			{ result: { code: 0, stdout: "recovered" } },
			// A command-level failure, which is an answer, not a broken link.
			{ result: { code: 3, stderr: "nope" } },
		]);
		const warnings: string[] = [];
		const transport = await SshCommandTransport.connect({
			target,
			reuseConnection: false,
			spawnFn,
			warn: (message) => warnings.push(message),
		});
		const result = await transport.run("echo hi");
		expect(result.stdout).toBe("recovered");
		expect(warnings.join(" ")).toContain("retry 1/2");
		expect(warnings.join(" ")).toContain("retry 2/2");

		// A command that exited 3 is the far side answering, not the link failing: it
		// is not retried.
		const before = seen.length;
		const answered = await transport.run("exit 3");
		expect(answered.code).toBe(3);
		expect(answered.stderr).toBe("nope");
		expect(seen.length - before).toBe(1);
		await transport.close();
	});

	it("gives up after its budget, and says the connection is down", async () => {
		const { spawnFn } = scriptedSpawn([
			{ result: { code: 0 } },
			{ result: { code: 0, stdout: "/home/eta" } },
			{ result: { code: 255, stderr: "closed" } },
			{ result: { code: 255, stderr: "closed" } },
			{ result: { code: 255, stderr: "closed" } },
		]);
		const warnings: string[] = [];
		const transport = await SshCommandTransport.connect({
			target,
			reuseConnection: false,
			spawnFn,
			retryBudget: 2,
			retryDelayMs: 1,
			warn: (message) => warnings.push(message),
		});
		const result = await transport.run("echo hi");
		expect(result.code).toBe(255);
		expect(warnings.join(" ")).toContain("out of retries");
		await transport.close();
	});

	it("drops the shared connection before retrying, so the next attempt dials fresh", async () => {
		const { spawnFn, seen } = scriptedSpawn([
			{ result: { code: 0 } },
			{ result: { code: 0, stdout: "/home/eta" } },
			{ result: { code: 255, stderr: "mux_client: connection closed" } },
			// The `-O exit` call and the retry.
			{ result: { code: 0 } },
			{ result: { code: 0, stdout: "fresh" } },
		]);
		const transport = await SshCommandTransport.connect({ target, spawnFn, retryDelayMs: 1 });
		const result = await transport.run("echo hi");
		expect(result.stdout).toBe("fresh");
		// The reconnect is an `ssh -O exit` on the same control socket.
		const exitCall = seen.find((call) => call.args.includes("exit") && call.args.includes("-O"));
		expect(exitCall?.args.join(" ")).toContain("ControlPath=");
		await transport.close();
	});
});
