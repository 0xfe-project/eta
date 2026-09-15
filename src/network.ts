import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { NetworkConfig } from "@eta/core/provider-config";

const exec = promisify(execFile);
type Environment = Record<string, string | undefined>;
export type SystemProxy = { http?: string; https?: string; bypass?: string; warning?: "pac_unsupported" | "system_unavailable" };
export type NetworkStatus = { source: "environment" | "system" | "manual" | "direct"; warning?: SystemProxy["warning"] };
export type NetworkCommand = (file: string, args: string[]) => Promise<string>;
const command: NetworkCommand = async (file, args) => (await exec(file, args, { timeout: 3000, maxBuffer: 64 * 1024, windowsHide: true })).stdout;
const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
const localBypass = "localhost,127.0.0.1,::1";

function endpoint(host: string | undefined, port: string | number | undefined) {
	if (!host || !/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) return undefined;
	return `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
}
function bypass(entries: string[]) {
	return entries.filter(v => v && v !== "<local>").map(v => v.startsWith("*.") ? v.slice(1) : v).join(",");
}
export function parseMacProxy(text: string): SystemProxy {
	const value = (key: string) => text.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, "m"))?.[1]?.trim();
	const out: SystemProxy = {
		http: value("HTTPEnable") === "1" ? endpoint(value("HTTPProxy"), value("HTTPPort")) : undefined,
		https: value("HTTPSEnable") === "1" ? endpoint(value("HTTPSProxy"), value("HTTPSPort")) : undefined,
		bypass: bypass([...text.matchAll(/^\s*\d+\s*:\s*(.+)$/gm)].map(match => match[1]!.trim())),
	};
	if (value("ProxyAutoConfigEnable") === "1" || value("ProxyAutoDiscoveryEnable") === "1") out.warning = "pac_unsupported";
	else if (!out.http && !out.https && value("SOCKSEnable") === "1") out.warning = "system_unavailable";
	return out;
}
export async function readSystemProxy(platform = process.platform, run: NetworkCommand = command): Promise<SystemProxy> {
	try {
		if (platform === "darwin") return parseMacProxy(await run("/usr/sbin/scutil", ["--proxy"]));
		if (platform === "win32") {
			const value = JSON.parse(await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' | Select-Object ProxyEnable,ProxyServer,ProxyOverride,AutoConfigURL | ConvertTo-Json -Compress"]));
			if (value.AutoConfigURL) return { warning: "pac_unsupported" };
			if (!value.ProxyEnable) return {};
			const entries = String(value.ProxyServer ?? "").split(";");
			const proxy = (scheme: string) => { const raw = entries.find(v => v.startsWith(`${scheme}=`))?.slice(scheme.length + 1) ?? entries.find(v => !v.includes("=")); return raw ? (raw.includes("://") ? raw : `http://${raw}`) : undefined; };
			return { http: proxy("http"), https: proxy("https"), bypass: bypass(String(value.ProxyOverride ?? "").split(";")) };
		}
		if (platform === "linux") {
			const get = async (schema: string, key: string) => (await run("gsettings", ["get", schema, key])).trim().replace(/^'|'$/g, "");
			const mode = await get("org.gnome.system.proxy", "mode");
			if (mode === "auto") return { warning: "pac_unsupported" };
			if (mode === "none") return {};
			if (mode !== "manual") return { warning: "system_unavailable" };
			const [http, httpPort, https, httpsPort, ignored] = await Promise.all([
				get("org.gnome.system.proxy.http", "host"), get("org.gnome.system.proxy.http", "port"),
				get("org.gnome.system.proxy.https", "host"), get("org.gnome.system.proxy.https", "port"), get("org.gnome.system.proxy", "ignore-hosts"),
			]);
			return { http: endpoint(http, httpPort), https: endpoint(https, httpsPort), bypass: bypass([...ignored.matchAll(/'([^']+)'/g)].map(match => match[1]!)) };
		}
	} catch { return { warning: "system_unavailable" }; }
	return { warning: "system_unavailable" };
}

/** Runs before sessions/providers start. No TLS overrides or global fetch replacement. */
export async function initializeNetwork(config: NetworkConfig = { mode: "system" }, env: Environment = process.env, detect: () => Promise<SystemProxy> = readSystemProxy): Promise<NetworkStatus> {
	if (config.mode === "system" && proxyKeys.some(key => env[key] !== undefined)) return { source: "environment" };
	if (config.mode === "direct") {
		for (const key of proxyKeys) env[key] = "";
		env.NO_PROXY = env.no_proxy = "*";
		return { source: "direct" };
	}
	const system = config.mode === "system" ? await detect() : undefined;
	const http = config.mode === "manual" ? config.proxyUrl : system?.http;
	const https = config.mode === "manual" ? config.proxyUrl : system?.https;
	for (const key of proxyKeys) delete env[key];
	if (http) env.HTTP_PROXY = env.http_proxy = http;
	if (https) env.HTTPS_PROXY = env.https_proxy = https;
	const exceptions = config.mode === "manual" ? config.noProxy : env.NO_PROXY ?? env.no_proxy ?? system?.bypass;
	env.NO_PROXY = env.no_proxy = [localBypass, exceptions].filter(Boolean).join(",");
	return { source: config.mode, ...(system?.warning ? { warning: system.warning } : {}) };
}
