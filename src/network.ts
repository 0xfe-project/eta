/**
 * Proxy resolution: where the server's network settings come from.
 *
 * Three sources, in the order a person would expect them to win:
 *
 * - **`manual`** — the config file names a proxy. Nothing is detected, nothing is guessed.
 * - **`system`** — ask the OS. macOS and Windows and Linux each keep this in a different place,
 *   which is the whole reason this file exists.
 * - **`direct`** — no proxy at all, and the environment is *emptied* rather than left alone: a
 *   machine with `HTTPS_PROXY` exported for a shell is not a machine where "direct" means "keep
 *   using it".
 *
 * What it does **not** do is worth naming, because every alternative is a trap:
 *
 * - **No TLS overrides and no global fetch replacement.** A proxy is an environment variable, and
 *   that is the whole mechanism: whatever client the provider layer uses picks it up the way any
 *   Node process would.
 * - **A PAC file is a warning, not a silent nothing.** Automatic proxy configuration is a script,
 *   and running one to discover a proxy is a capability this does not have. Saying so is the
 *   difference between "your proxy is not being used" and "the app ignored your settings".
 * - **A SOCKS-only system proxy is the same kind of warning.** It is configured, it is not
 *   supported, and the honest answer is to say which of the two it is.
 *
 * `NO_PROXY` always carries the loopback names: a proxy that is supposed to reach the internet must
 * not intercept a request to the machine the server is running on.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { NetworkConfig } from "@eta/client-wire-proto";

const exec = promisify(execFile);
type Environment = Record<string, string | undefined>;

/** What the OS said, when it said anything. */
export interface SystemProxy {
	http?: string;
	https?: string;
	/** Hosts to skip, comma-joined. */
	bypass?: string;
	warning?: "pac_unsupported" | "system_unavailable";
}

/** Where the settings in force came from, and what is worth telling the user. */
export interface NetworkStatus {
	source: "environment" | "system" | "manual" | "direct";
	warning?: SystemProxy["warning"];
}

/** Running a command, shaped so a test can hand in its own. */
export type NetworkCommand = (file: string, args: string[]) => Promise<string>;

const command: NetworkCommand = async (file, args) =>
	(await exec(file, args, { timeout: 3_000, maxBuffer: 64 * 1024, windowsHide: true })).stdout;

/** Every spelling of "there is a proxy" an environment may carry. */
export const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] as const;

/** Always bypassed: a proxy for the internet must not intercept the machine the server is on. */
const LOCAL_BYPASS = "localhost,127.0.0.1,::1";

/** `host:port` as a URL, refusing anything that is not a usable endpoint. */
function endpoint(host: string | undefined, port: string | number | undefined): string | undefined {
	if (!host || !/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65_535) return undefined;
	return `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
}

/**
 * Normalise a bypass list.
 *
 * `<local>` is the Windows spelling of "everything on this machine" and the loopback names are
 * added anyway, so the token is dropped rather than forwarded as a literal hostname nobody can
 * resolve. `*.example.com` becomes `.example.com`, which is the form every proxy understands.
 */
function bypass(entries: string[]): string {
	return entries
		.filter((value) => value && value !== "<local>")
		.map((value) => (value.startsWith("*.") ? value.slice(1) : value))
		.join(",");
}

/** `scutil --proxy` output, as macOS prints it. */
export function parseMacProxy(text: string): SystemProxy {
	const value = (key: string): string | undefined =>
		text.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, "m"))?.[1]?.trim();
	const out: SystemProxy = {
		http: value("HTTPEnable") === "1" ? endpoint(value("HTTPProxy"), value("HTTPPort")) : undefined,
		https: value("HTTPSEnable") === "1" ? endpoint(value("HTTPSProxy"), value("HTTPSPort")) : undefined,
		bypass: bypass([...text.matchAll(/^\s*\d+\s*:\s*(.+)$/gm)].map((match) => (match[1] ?? "").trim())),
	};
	// A PAC file is a script this does not run; a SOCKS-only proxy is configured and unsupported.
	// They are different answers and the user should hear the right one.
	if (value("ProxyAutoConfigEnable") === "1" || value("ProxyAutoDiscoveryEnable") === "1") {
		out.warning = "pac_unsupported";
	} else if (!out.http && !out.https && value("SOCKSEnable") === "1") {
		out.warning = "system_unavailable";
	}
	return out;
}

/** Windows' `Internet Settings`, as PowerShell prints them. */
export function parseWindowsProxy(text: string): SystemProxy {
	const value = JSON.parse(text) as {
		ProxyEnable?: number;
		ProxyServer?: string;
		ProxyOverride?: string;
		AutoConfigURL?: string;
	};
	if (value.AutoConfigURL) return { warning: "pac_unsupported" };
	if (!value.ProxyEnable) return {};
	const entries = String(value.ProxyServer ?? "").split(";");
	const proxy = (scheme: string): string | undefined => {
		const raw =
			entries.find((entry) => entry.startsWith(`${scheme}=`))?.slice(scheme.length + 1) ??
			entries.find((entry) => !entry.includes("="));
		return raw ? (raw.includes("://") ? raw : `http://${raw}`) : undefined;
	};
	return {
		http: proxy("http"),
		https: proxy("https"),
		bypass: bypass(String(value.ProxyOverride ?? "").split(";")),
	};
}

/** Linux' GNOME settings, as `gsettings` prints them (with the quotes it adds). */
export function parseLinuxProxy(values: {
	mode: string;
	http: string;
	httpPort: string;
	https: string;
	httpsPort: string;
	ignored: string;
}): SystemProxy {
	if (values.mode === "auto") return { warning: "pac_unsupported" };
	if (values.mode === "none") return {};
	if (values.mode !== "manual") return { warning: "system_unavailable" };
	return {
		http: endpoint(values.http, values.httpPort),
		https: endpoint(values.https, values.httpsPort),
		bypass: bypass([...values.ignored.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? "")),
	};
}

/** Ask the OS for its proxy settings. */
export async function readSystemProxy(
	platform: string = process.platform,
	run: NetworkCommand = command,
): Promise<SystemProxy> {
	try {
		if (platform === "darwin") return parseMacProxy(await run("/usr/sbin/scutil", ["--proxy"]));
		if (platform === "win32") {
			return parseWindowsProxy(
				await run("powershell.exe", [
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					"Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' | Select-Object ProxyEnable,ProxyServer,ProxyOverride,AutoConfigURL | ConvertTo-Json -Compress",
				]),
			);
		}
		if (platform === "linux") {
			const get = async (schema: string, key: string): Promise<string> =>
				(await run("gsettings", ["get", schema, key])).trim().replace(/^'|'$/g, "");
			const [mode, http, httpPort, https, httpsPort, ignored] = await Promise.all([
				get("org.gnome.system.proxy", "mode"),
				get("org.gnome.system.proxy.http", "host"),
				get("org.gnome.system.proxy.http", "port"),
				get("org.gnome.system.proxy.https", "host"),
				get("org.gnome.system.proxy.https", "port"),
				get("org.gnome.system.proxy", "ignore-hosts"),
			]);
			return parseLinuxProxy({ mode, http, httpPort, https, httpsPort, ignored });
		}
	} catch {
		// A missing `scutil`, a locked-down PowerShell, no `gsettings`: all the same answer.
		return { warning: "system_unavailable" };
	}
	return { warning: "system_unavailable" };
}

/**
 * Put the settings in force, and say where they came from.
 *
 * Called before sessions or providers start, because it edits the *environment*: whatever client
 * the provider layer builds later inherits it. The returned status is what a settings page shows —
 * including the warning that a configured proxy is not being used, which is the one thing a user
 * cannot find out any other way.
 */
export async function initializeNetwork(
	config: NetworkConfig = { mode: "system" },
	env: Environment = process.env,
	detect: () => Promise<SystemProxy> = readSystemProxy,
): Promise<NetworkStatus> {
	// An environment that already names a proxy is the user's own answer, and `system` mode does
	// not overrule it — that is what "system" means when the environment *is* the system's answer.
	if (config.mode === "system" && PROXY_KEYS.some((key) => env[key] !== undefined)) return { source: "environment" };
	if (config.mode === "direct") {
		for (const key of PROXY_KEYS) env[key] = "";
		env.NO_PROXY = env.no_proxy = "*";
		return { source: "direct" };
	}
	const system = config.mode === "system" ? await detect() : undefined;
	const http = config.mode === "manual" ? config.proxyUrl : system?.http;
	const https = config.mode === "manual" ? config.proxyUrl : system?.https;
	for (const key of PROXY_KEYS) delete env[key];
	if (http) env.HTTP_PROXY = env.http_proxy = http;
	if (https) env.HTTPS_PROXY = env.https_proxy = https;
	const exceptions = config.mode === "manual" ? config.noProxy : (env.NO_PROXY ?? env.no_proxy ?? system?.bypass);
	env.NO_PROXY = env.no_proxy = [LOCAL_BYPASS, exceptions].filter(Boolean).join(",");
	return { source: config.mode, ...(system?.warning === undefined ? {} : { warning: system.warning }) };
}
