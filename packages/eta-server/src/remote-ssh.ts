import { existsSync } from "node:fs";
import { readFile, stat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";
import type { RemoteConnection } from "@eta/core/remote";

export function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
export function validHost(value: string): boolean { return /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,252}$/.test(value); }
export function sshArgs(connection: RemoteConnection): string[] {
	const args = ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=12", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "ControlMaster=no", "-o", "ControlPath=none"];
	if (connection.port) args.push("-p", String(connection.port));
	if (connection.user) args.push("-l", connection.user);
	if (connection.identityFile) args.push("-i", connection.identityFile.startsWith("~/") ? join(homedir(), connection.identityFile.slice(2)) : connection.identityFile);
	return args;
}
export interface CommandResult { stdout: string; stderr: string; code: number }
export async function command(args: string[], input?: Uint8Array, timeoutMs = 30_000, env?: NodeJS.ProcessEnv): Promise<CommandResult> {
	const helperScript = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(args[0] ?? "") && existsSync(`${args[0]}.js`) ? `${args[0]}.js` : undefined;
	const spawnArgs = helperScript === undefined ? args : [process.execPath, helperScript, ...args.slice(1)];
	const proc = Bun.spawn(spawnArgs, { env, stdin: input ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => proc.kill(), timeoutMs);
	try {
		if (input && proc.stdin && typeof proc.stdin !== "number") { proc.stdin.write(input); await proc.stdin.end(); }
		const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { stdout, stderr, code };
	} finally { clearTimeout(timer); }
}
export async function ssh(connection: RemoteConnection, script: string, input?: Uint8Array, timeoutMs?: number): Promise<string> {
	const result = await command(["ssh", ...sshArgs(connection), "--", connection.host, `sh -c ${shellQuote(script)}`], input, timeoutMs);
	if (result.code !== 0) throw new Error(result.stderr.trim().slice(-1600) || `SSH exited ${result.code}. Run ssh ${connection.host} in a terminal to verify the host key and authentication.`);
	return result.stdout.trim();
}

/** Includes are expanded here only to discover names; OpenSSH remains the resolver. */
export async function discoverSshHosts(path = join(homedir(), ".ssh/config")): Promise<string[]> {
	const hosts = new Set<string>();
	const visited = new Set<string>();
	const read = async (file: string, depth: number): Promise<void> => {
		if (depth > 12 || visited.has(file)) return;
		visited.add(file);
		const text = await readFile(file, "utf8").catch(() => "");
		for (const line of text.split(/\r?\n/)) {
			const tokens = line.replace(/\s+#.*$/, "").trim().match(/(?:"[^"]*"|'[^']*'|[^\s=]+)/g)?.map(value => value.replace(/^['"]|['"]$/g, "")) ?? [];
			const key = tokens.shift()?.toLowerCase();
			if (key === "host") for (const host of tokens) if (validHost(host)) hosts.add(host);
			if (key === "include") for (const pattern of tokens) {
				const absolute = pattern.startsWith("/") ? pattern : pattern.startsWith("~/") ? join(homedir(), pattern.slice(2)) : resolve(dirname(file), pattern);
				if (/[*?[]/.test(absolute)) {
					for await (const included of new Bun.Glob(absolute.split("/").pop()!).scan({ cwd: dirname(absolute), absolute: true, onlyFiles: true })) await read(included, depth + 1);
				} else await read(absolute, depth + 1);
			}
		}
	};
	await read(path, 0);
	return [...hosts].sort();
}
export async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => { const port = (server.address() as { port: number }).port; server.close(error => error ? reject(error) : resolve(port)); });
	});
}

/** Newest mtime under a directory: the build is stale the moment a source changes. */
async function newestSourceMtime(directory: string, depth = 0): Promise<number> {
	if (depth > 6) return 0;
	let newest = 0;
	for await (const entry of new Bun.Glob("**/*.{ts,json}").scan({ cwd: directory, absolute: true, onlyFiles: true })) {
		const info = await stat(entry).catch(() => null);
		if (info !== null && info.mtimeMs > newest) newest = info.mtimeMs;
	}
	return newest;
}

export async function remoteArtifact(platform: string, arch: string): Promise<{ path: string; version: string }> {
	if (!["Linux", "Darwin"].includes(platform) || !["x86_64", "aarch64", "arm64"].includes(arch)) throw new Error(`Unsupported remote platform: ${platform} ${arch}. Supported: Linux/macOS x64/arm64.`);
	const target = `bun-${platform === "Linux" ? "linux" : "darwin"}-${arch === "x86_64" ? "x64" : "arm64"}`;
	const directory = process.env.ETA_REMOTE_BIN_DIR ?? resolve(import.meta.dir, "../artifacts/remote");
	const path = join(directory, `eta-remote-${target}`);
	const artifactDate = (await stat(path).catch(() => null))?.mtimeMs ?? 0;
	const sourceDate = await newestSourceMtime(resolve(import.meta.dir, "..", "src"));
	if (!(await stat(path).catch(() => null))?.isFile() || sourceDate > artifactDate) {
		const entry = resolve(import.meta.dir, "remote-main.ts");
		if (!(await stat(entry).catch(() => null))?.isFile()) throw new Error("Remote binary missing from this installation. Set ETA_REMOTE_BIN_DIR to the packaged remote artifacts directory.");
		await mkdir(directory, { recursive: true });
		const result = await command([process.execPath, "build", entry, "--compile", `--target=${target}`, `--outfile=${path}`], undefined, 240_000);
		if (result.code !== 0) throw new Error(`Remote build failed: ${result.stderr.slice(-1200)}`);
	}
	const bytes = await Bun.file(path).arrayBuffer();
	return { path, version: new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 20) };
}
