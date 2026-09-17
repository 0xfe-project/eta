import { describe, expect, it } from "bun:test";
import { access } from "node:fs/promises";
import { confirmSshHost, hostKeyFingerprint } from "../src/remote-host-key.ts";
import { command } from "../src/remote-ssh.ts";
import { classifyRemoteError, RemoteManager, validateConnection } from "../src/remotes.ts";

const prompt = "The authenticity of host 'devbox (192.0.2.1)' can't be established.\nED25519 key fingerprint is: SHA256:abc123+/\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ";
const connection = validateConnection({ id: "dev", name: "devbox", host: "devbox" });

describe("SSH host trust", () => {
	it("reads OpenSSH fingerprints on macOS and Linux, not password prompts", () => {
		expect(hostKeyFingerprint(prompt)).toEqual({ algorithm: "ED25519", fingerprint: "SHA256:abc123+/" });
		expect(hostKeyFingerprint(prompt.replace("is:", "is").replace("+/\n", "+/.\n"))?.fingerprint).toBe("SHA256:abc123+/");
		expect(hostKeyFingerprint("Password: ")).toBeUndefined();
		expect(classifyRemoteError(new Error("Host key verification failed.")).kind).toBe("host-key");
		expect(classifyRemoteError(new Error("REMOTE HOST IDENTIFICATION HAS CHANGED! Host key verification failed.")).kind).toBe("host-key-changed");
	});

	it("captures without accepting; approves only an identical prompt and cleans helpers", async () => {
		let actual = prompt;
		let answer = "";
		let helper = "";
		const run: typeof command = async (args, _input, _timeout, env) => {
			expect(args).toContain("StrictHostKeyChecking=ask");
			expect(args).toContain("PreferredAuthentications=none");
			helper = env!.SSH_ASKPASS!;
			const result = await command([helper, actual], undefined, 1000, env);
			answer = result.stdout;
			return { stdout: "", stderr: "Permission denied", code: 255 };
		};
		expect(await confirmSshHost(connection, undefined, run)).toBe(prompt);
		expect(answer).toBe("");
		await expect(access(helper)).rejects.toThrow();
		await confirmSshHost(connection, prompt, run);
		expect(answer).toBe("yes\n");
		await expect(access(helper)).rejects.toThrow();
		actual = prompt.replace("abc123", "different");
		await expect(confirmSshHost(connection, prompt, run)).rejects.toThrow("changed or expired");
		expect(answer).toBe("");
		actual = "Enter passphrase for key '/home/user/.ssh/id_ed25519': ";
		await expect(confirmSshHost(connection, prompt, run)).rejects.toThrow();
		expect(answer).toBe("");
	});

	it("pauses auto-connect for trust without publishing an error or retrying", async () => {
		let attempts = 0;
		const states: { status: string; error?: string }[] = [];
		const manager = new RemoteManager("unused", () => {}, () => { states.push(...manager.list()); }, {
			exec: async () => { attempts++; throw new Error("No ED25519 host key is known. Host key verification failed."); },
			inspect: async () => ({ hostname: "devbox", user: "dev" }),
			openTunnel: async () => { throw new Error("unused"); }, artifact: async () => { throw new Error("unused"); },
		});
		(manager as unknown as { connections: typeof connection[] }).connections = [{ ...connection, autoConnect: true }];
		try {
			manager.start();
			await Bun.sleep(20);
			expect(manager.list()[0]?.status).toBe("awaiting-trust");
			expect(states.some(state => state.status === "error" || state.error !== undefined)).toBe(false);
			await Bun.sleep(1500);
			expect(attempts).toBe(1);
		} finally { manager.close(); }
	});

	it("requires a current, matching, single-use confirmation", async () => {
		const trusted: string[] = [];
		const manager = new RemoteManager("unused", () => {}, () => {}, {
			exec: async () => "", inspect: async () => ({ hostname: "devbox", user: "dev" }),
			openTunnel: async () => { throw new Error("unused"); }, artifact: async () => { throw new Error("unused"); },
			confirmHost: async (_connection, expected) => { if (expected) trusted.push(expected); return prompt; },
		});
		// No persistence or network needed to exercise the confirmation contract.
		(manager as unknown as { connections: typeof connection[] }).connections = [connection];
		const key = await manager.hostKey("dev");
		await expect(manager.trustHost("dev", "invented")).rejects.toThrow();
		expect(trusted).toEqual([]);
		await manager.trustHost("dev", key.challengeId);
		expect(trusted).toEqual([prompt]);
		await expect(manager.trustHost("dev", key.challengeId)).rejects.toThrow();
		const changed = await manager.hostKey("dev");
		connection.host = "another-host";
		await expect(manager.trustHost("dev", changed.challengeId)).rejects.toThrow();
		manager.close();
	});
});
