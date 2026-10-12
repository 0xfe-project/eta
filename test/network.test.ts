/**
 * Proxy resolution (S22).
 *
 * Every platform keeps its proxy settings somewhere different, so the tests are sample *text*: the
 * exact shape `scutil --proxy` prints, the exact JSON PowerShell emits, the exact `gsettings`
 * output. That is the part worth pinning down — the parsing — and it needs no network and no OS.
 *
 * The two rules the tests care most about are the ones a user would otherwise have to discover by
 * noticing that their proxy is silently not being used: a **PAC file** is reported as unsupported
 * rather than ignored, and a **SOCKS-only** system proxy is reported as the different thing it is.
 */
import { describe, expect, it } from "vitest";
import {
	initializeNetwork,
	type NetworkCommand,
	parseLinuxProxy,
	parseMacProxy,
	parseWindowsProxy,
	readSystemProxy,
} from "../src/network";

/** macOS' `scutil --proxy` output, in the `Key : value` form it actually prints. */
const MAC_WITH_PROXY = `HTTPEnable : 1
HTTPProxy : 127.0.0.1
HTTPPort : 7890
HTTPSEnable : 1
HTTPSProxy : 127.0.0.1
HTTPSPort : 7890
ExceptionsList : <array> {
0 : *.local
1 : 169.254/16
}`;

describe("macOS", () => {
	it("reads an enabled HTTP and HTTPS proxy", () => {
		const proxy = parseMacProxy(MAC_WITH_PROXY);
		expect(proxy.http).toBe("http://127.0.0.1:7890");
		expect(proxy.https).toBe("http://127.0.0.1:7890");
		expect(proxy.warning).toBeUndefined();
	});

	it("says nothing when no proxy is enabled", () => {
		const proxy = parseMacProxy("HTTPEnable : 0");
		expect(proxy.http).toBeUndefined();
		expect(proxy.https).toBeUndefined();
		expect(proxy.warning).toBeUndefined();
	});

	it("refuses a port that is not a port", () => {
		// A proxy line with no port is not a proxy: guessing 80 would send traffic somewhere
		// nobody asked for.
		const proxy = parseMacProxy("HTTPEnable : 1\nHTTPProxy : 1.2.3.4");
		expect(proxy.http).toBeUndefined();
	});

	it("reports a PAC file as unsupported rather than ignoring it", () => {
		const proxy = parseMacProxy("ProxyAutoConfigEnable : 1");
		expect(proxy.warning).toBe("pac_unsupported");
	});

	it("reports a SOCKS-only proxy as unavailable, which is a different thing", () => {
		const proxy = parseMacProxy("SOCKSEnable : 1");
		expect(proxy.warning).toBe("system_unavailable");
		expect(proxy.http).toBeUndefined();
	});
});

describe("Windows", () => {
	it("reads a per-scheme proxy list", () => {
		const proxy = parseWindowsProxy(
			JSON.stringify({
				ProxyEnable: 1,
				ProxyServer: "http=127.0.0.1:7890;https=127.0.0.1:7891",
				ProxyOverride: "localhost;<local>;*.internal",
			}),
		);
		expect(proxy.http).toBe("http://127.0.0.1:7890");
		expect(proxy.https).toBe("http://127.0.0.1:7891");
		// `<local>` is Windows' spelling of "everything on this machine": dropped, not forwarded.
		expect(proxy.bypass).toBe("localhost,.internal");
	});

	it("reads a bare host:port, which is how a single-proxy machine stores it", () => {
		const proxy = parseWindowsProxy(JSON.stringify({ ProxyEnable: 1, ProxyServer: "127.0.0.1:7890" }));
		expect(proxy.http).toBe("http://127.0.0.1:7890");
		expect(proxy.https).toBe("http://127.0.0.1:7890");
	});

	it("is nothing when the proxy is switched off, and a warning when it is a PAC file", () => {
		expect(parseWindowsProxy(JSON.stringify({ ProxyEnable: 0, ProxyServer: "127.0.0.1:7890" }))).toEqual({});
		expect(parseWindowsProxy(JSON.stringify({ AutoConfigURL: "http://x/proxy.pac" }))).toEqual({
			warning: "pac_unsupported",
		});
	});
});

describe("Linux", () => {
	it("reads a manual configuration and its ignore list", () => {
		const proxy = parseLinuxProxy({
			mode: "manual",
			http: "127.0.0.1",
			httpPort: "7890",
			https: "127.0.0.1",
			httpsPort: "7890",
			ignored: "['localhost', '127.0.0.0/8', '*.internal']",
		});
		expect(proxy.http).toBe("http://127.0.0.1:7890");
		expect(proxy.bypass).toBe("localhost,127.0.0.0/8,.internal");
	});

	it("tells `auto`, `none` and anything else apart", () => {
		const base = { http: "", httpPort: "0", https: "", httpsPort: "0", ignored: "" };
		expect(parseLinuxProxy({ ...base, mode: "auto" })).toEqual({ warning: "pac_unsupported" });
		expect(parseLinuxProxy({ ...base, mode: "none" })).toEqual({});
		expect(parseLinuxProxy({ ...base, mode: "something-new" })).toEqual({ warning: "system_unavailable" });
	});
});

describe("asking the system", () => {
	it("runs the right command for the platform, and answers `unavailable` when it cannot", async () => {
		const ran: string[] = [];
		const run: NetworkCommand = async (file) => {
			ran.push(file);
			return MAC_WITH_PROXY;
		};
		expect((await readSystemProxy("darwin", run)).http).toBe("http://127.0.0.1:7890");
		expect(ran).toEqual(["/usr/sbin/scutil"]);

		// A platform with nothing to ask, and a command that throws, are the same answer.
		expect(await readSystemProxy("sunos", run)).toEqual({ warning: "system_unavailable" });
		expect(
			await readSystemProxy("darwin", async () => {
				throw new Error("no scutil here");
			}),
		).toEqual({ warning: "system_unavailable" });
	});
});

describe("putting the settings in force", () => {
	it("leaves an environment that already names a proxy alone", async () => {
		const env: Record<string, string | undefined> = { HTTPS_PROXY: "http://corp:8080" };
		const status = await initializeNetwork({ mode: "system" }, env, async () => ({ http: "http://system:1" }));
		// The environment *is* the user's answer, and `system` mode does not overrule it.
		expect(status).toEqual({ source: "environment" });
		expect(env.HTTPS_PROXY).toBe("http://corp:8080");
	});

	it("applies a manual proxy and always bypasses the loopback", async () => {
		const env: Record<string, string | undefined> = { HTTPS_PROXY: "http://stale:1" };
		const status = await initializeNetwork(
			{ mode: "manual", proxyUrl: "http://127.0.0.1:7890", noProxy: "corp.internal" },
			env,
		);
		expect(status.source).toBe("manual");
		expect(env.HTTP_PROXY).toBe("http://127.0.0.1:7890");
		expect(env.https_proxy).toBe("http://127.0.0.1:7890");
		// The stale one is gone: a settings change that leaves the old value in place is a settings
		// change that did not happen.
		expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
		expect(env.NO_PROXY).toBe("localhost,127.0.0.1,::1,corp.internal");
	});

	it("empties the environment for `direct`, because that is what direct means", async () => {
		const env: Record<string, string | undefined> = {
			HTTPS_PROXY: "http://corp:8080",
			http_proxy: "http://corp:8080",
		};
		const status = await initializeNetwork({ mode: "direct" }, env);
		expect(status.source).toBe("direct");
		expect(env.HTTPS_PROXY).toBe("");
		expect(env.http_proxy).toBe("");
		// `*` is the one value every client reads as "no proxy for anything".
		expect(env.NO_PROXY).toBe("*");
	});

	it("carries the system's warning through, so a user finds out", async () => {
		const env: Record<string, string | undefined> = {};
		const status = await initializeNetwork({ mode: "system" }, env, async () => ({ warning: "pac_unsupported" }));
		expect(status).toEqual({ source: "system", warning: "pac_unsupported" });
		// And with nothing to apply, the loopback bypass is still set.
		expect(env.NO_PROXY).toBe("localhost,127.0.0.1,::1");
	});

	it("uses the system's proxy and its bypass list when there is one", async () => {
		const env: Record<string, string | undefined> = {};
		await initializeNetwork({ mode: "system" }, env, async () => ({
			http: "http://127.0.0.1:7890",
			https: "http://127.0.0.1:7890",
			bypass: ".internal",
		}));
		expect(env.HTTP_PROXY).toBe("http://127.0.0.1:7890");
		expect(env.NO_PROXY).toBe("localhost,127.0.0.1,::1,.internal");
	});
});
