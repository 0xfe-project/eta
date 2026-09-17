import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteConnection } from "@eta/core/remote";
import { command, shellQuote, sshArgs } from "./remote-ssh.ts";

/** Let OpenSSH resolve aliases, proxies and known_hosts itself. Only its host-key
 * confirmation is captured; password/passphrase prompts are never answered. */
export async function confirmSshHost(connection: RemoteConnection, expected?: string, run: typeof command = command): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "eta-host-key-"));
	try {
		const prompt = join(directory, "prompt");
		const accepted = join(directory, "accepted");
		const helper = join(directory, "askpass");
		const expectedFile = join(directory, "expected");
		await writeFile(expectedFile, expected ?? "", { mode: 0o600 });
		await writeFile(helper, `#!/bin/sh
case "$1" in
  "The authenticity of host "*"key fingerprint is"*"Are you sure you want to continue connecting"*) ;;
  *) exit 1 ;;
esac
printf '%s' "$1" > ${shellQuote(prompt)}
${expected === undefined ? "exit 1" : `cmp -s ${shellQuote(prompt)} ${shellQuote(expectedFile)} || exit 1
printf yes > ${shellQuote(accepted)}
printf 'yes\\n'`}
`, { mode: 0o700 });
		const result = await run([
			"ssh", "-o", "BatchMode=no", "-o", "StrictHostKeyChecking=ask",
			"-o", "PreferredAuthentications=none", "-o", "NumberOfPasswordPrompts=0",
			"-o", "VerifyHostKeyDNS=no", "-o", "UpdateHostKeys=no",
			...sshArgs(connection), "--", connection.host, "true",
		], undefined, 30_000, {
			...process.env, LC_ALL: "C", SSH_ASKPASS: helper, SSH_ASKPASS_REQUIRE: "force", DISPLAY: "eta:0",
		});
		const captured = await readFile(prompt, "utf8").catch(() => "");
		if (expected !== undefined) {
			if (captured !== expected || await readFile(accepted, "utf8").catch(() => "") !== "yes")
				throw new Error("Host key confirmation changed or expired. Test the connection again and verify its fingerprint.");
			// Authentication is deliberately disabled; only OpenSSH's host trust is changed.
			if (/failed to add|could not.*known.hosts/i.test(result.stderr)) throw new Error(result.stderr.trim());
			return captured;
		}
		if (!hostKeyFingerprint(captured)) throw new Error(result.stderr.trim() || "No new host key to confirm. Test the connection again.");
		return captured;
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

export function hostKeyFingerprint(prompt: string): { algorithm: string; fingerprint: string } | undefined {
	if (!prompt.startsWith("The authenticity of host ") || !prompt.includes("Are you sure you want to continue connecting")) return undefined;
	const match = /([A-Z0-9-]+) key fingerprint is:? (SHA256:[A-Za-z0-9+/]+)(?:\.|\s|$)/.exec(prompt);
	return match ? { algorithm: match[1]!, fingerprint: match[2]! } : undefined;
}
