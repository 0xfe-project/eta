/**
 * Remote access, host identity probe (`/.well-known/eta/host`), smart multi-route discovery,
 * `machines.setTailscaleServe`, persistence across restarts, and the Token Gate security invariant.
 */
import type { MachineResults } from "@eta/client-contracts";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import {
  readTailscaleServePreference,
  TAILSCALE_SERVE_SETTING_KEY,
} from "../src/machines/remote-access";
import { MachineStore } from "../src/machines/store";
import { Tailscale } from "../src/machines/tailscale";
import { SettingStore } from "../src/settings/store";
import { connect } from "./support/client";
import { tempDir, testHost } from "./support/host";
import { world } from "./support/world";

interface FakeTailscaleOptions {
  running?: boolean;
  dnsName?: string;
  httpsCapable?: boolean;
  addresses?: string[];
  serveStatus?: unknown;
  failServeWith?: Error;
  failDisableWith?: Error;
}

/** A scripted `tailscale` CLI that tracks every command it runs. */
function fakeTailscale(options: FakeTailscaleOptions = {}) {
  const calls: string[][] = [];
  let serveStatus: unknown = options.serveStatus ?? {};
  const running = options.running ?? true;
  const dnsName = options.dnsName ?? "box.tail1234.ts.net.";
  const httpsCapable = options.httpsCapable ?? true;
  const addresses = options.addresses ?? ["100.64.0.10"];

  const statusPayload = {
    BackendState: running ? "Running" : "Stopped",
    Self: {
      ID: "nSELF",
      HostName: "box",
      DNSName: dnsName,
      TailscaleIPs: addresses,
      OS: "darwin",
      Online: running,
      UserID: 1,
      CapMap: httpsCapable ? { https: [] } : {},
    },
    Peer: {},
    User: { 1: { LoginName: "me@example.com" } },
  };

  const tailscale = new Tailscale({
    run: async (args) => {
      calls.push([...args]);
      if (args[0] === "status") return JSON.stringify(statusPayload);
      if (args[0] === "serve" && args[1] === "status") {
        return JSON.stringify(serveStatus);
      }
      if (args[0] === "serve" && args.includes("off")) {
        if (options.failDisableWith !== undefined)
          throw options.failDisableWith;
        serveStatus = {};
        return "";
      }
      if (args[0] === "serve" && args.includes("--bg")) {
        if (options.failServeWith !== undefined) throw options.failServeWith;
        const httpsArg = args.find((arg) => arg.startsWith("--https="));
        const servePort = httpsArg ? httpsArg.slice("--https=".length) : "443";
        const target = args.at(-1) ?? "http://127.0.0.1:8787";
        const hostKey = `${dnsName.replace(/\.$/, "")}:${servePort}`;
        serveStatus = {
          Web: {
            [hostKey]: {
              Handlers: {
                "/": { Proxy: target },
              },
            },
          },
        };
        return "";
      }
      if (args[0] === "ip") return `${addresses[0] ?? ""}\n`;
      throw new Error(`unexpected tailscale ${args.join(" ")}`);
    },
  });

  return {
    tailscale,
    calls,
    setServeStatus(next: unknown) {
      serveStatus = next;
    },
  };
}

/** Start a real local TCP listener to simulate another live service occupying a port. */
async function occupyTcpPort(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("/.well-known/eta/host", () => {
  it("returns only the stable primary machine hostId across restarts and refuses writes", async () => {
    const dataDir = await tempDir();
    const first = await testHost({ dataDir });
    const expectedId = new MachineStore(first.db).primary()!.id;

    const get = await fetch(
      `http://127.0.0.1:${first.port}/.well-known/eta/host`,
    );
    expect(get.status).toBe(200);
    expect(get.headers.get("cache-control")).toBe("no-store");
    const body = (await get.json()) as Record<string, unknown>;
    expect(body).toEqual({ hostId: expectedId });
    expect(Object.keys(body)).toEqual(["hostId"]);

    const head = await fetch(
      `http://127.0.0.1:${first.port}/.well-known/eta/host`,
      { method: "HEAD" },
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    const post = await fetch(
      `http://127.0.0.1:${first.port}/.well-known/eta/host`,
      { method: "POST" },
    );
    expect(post.status).toBe(405);

    await first.close();

    const second = await testHost({ dataDir });
    const getAgain = await fetch(
      `http://127.0.0.1:${second.port}/.well-known/eta/host`,
    );
    expect(await getAgain.json()).toEqual({ hostId: expectedId });
  });
});

describe("machines.addresses & phoneLink route priority", () => {
  it("reports loopback-only host with preferredUrl: null and reachable: false", async () => {
    const w = await world({ onCloudVm: false });
    const addresses = (await w.client.call(
      "machines",
      "addresses",
      {},
    )) as MachineResults["addresses"];
    expect(addresses.preferredUrl).toBeNull();
    expect(addresses.tailnet).toBeNull();
    expect(addresses.listeningHost).toBe("127.0.0.1");
    expect(addresses.port).toBe(w.host.port);
    expect(addresses.routes).toEqual([
      {
        kind: "loopback",
        url: `http://127.0.0.1:${w.host.port}`,
        label: "Localhost",
        reachable: false,
      },
    ]);
    expect(addresses.tailscaleServe).toMatchObject({
      installed: false,
      running: false,
      enabled: false,
      activeUrl: null,
      port: 443,
      diagnostic: "not-installed",
    });
  });

  it("prefers publicUrl over Tailscale HTTPS, and honors explicit phoneLink url", async () => {
    const fake = fakeTailscale();
    const w = await world({
      publicUrl: "https://eta.example.com/app",
      tailscale: fake.tailscale,
      tailscaleProbe: async () => true,
      onCloudVm: false,
    });
    const enabled = (await w.client.call("machines", "setTailscaleServe", {
      enabled: true,
    })) as MachineResults["setTailscaleServe"];
    expect(enabled.ok).toBe(true);
    expect(enabled.routes.map((route) => route.kind)).toEqual([
      "public",
      "tailscale_https",
      "loopback",
    ]);
    expect(enabled.preferredUrl).toBe("https://eta.example.com");

    const autoLink = (await w.client.call(
      "machines",
      "phoneLink",
      {},
    )) as MachineResults["phoneLink"];
    expect(autoLink.url).toBe("https://eta.example.com");
    expect(new URL(autoLink.link).searchParams.get("token")).toBeTruthy();

    const customLink = (await w.client.call("machines", "phoneLink", {
      url: "https://box.tail1234.ts.net/custom",
    })) as MachineResults["phoneLink"];
    expect(customLink.url).toBe("https://box.tail1234.ts.net");
  });
});

describe("machines.setTailscaleServe", () => {
  it("enables Tailscale HTTPS, forces the Token Gate before serving, allows the HTTPS origin, persists across restarts, and disables cleanly", async () => {
    const dataDir = await tempDir();
    const fake = fakeTailscale();
    const probed: Array<{
      baseUrl: string;
      expectedHostId: string;
      tailnetIpv4?: string;
    }> = [];

    const host = await testHost({
      dataDir,
      tailscale: fake.tailscale,
      onCloudVm: false,
      tailscaleProbe: async (input) => {
        probed.push({
          baseUrl: input.baseUrl,
          expectedHostId: input.expectedHostId,
          tailnetIpv4: input.tailnetIpv4,
        });
        // Verify the host's /.well-known/eta/host actually returns this hostId even with Token Gate ON!
        const res = await fetch(
          `http://127.0.0.1:${host.port}/.well-known/eta/host`,
        );
        const json = (await res.json()) as { hostId: string };
        return json.hostId === input.expectedHostId;
      },
    });
    expect(host.tokenFile).toBeUndefined();

    const client = await connect(`ws://127.0.0.1:${host.port}/ws`);
    await client.hello();

    const enabled = (await client.call("machines", "setTailscaleServe", {
      enabled: true,
    })) as MachineResults["setTailscaleServe"];

    expect(enabled.ok).toBe(true);
    expect(enabled.preferredUrl).toBe("https://box.tail1234.ts.net");
    expect(enabled.tailscaleServe).toMatchObject({
      installed: true,
      running: true,
      magicDnsName: "box.tail1234.ts.net",
      httpsCapable: true,
      enabled: true,
      activeUrl: "https://box.tail1234.ts.net",
      port: 443,
      holderStatus: "ours",
    });
    expect(probed).toHaveLength(1);
    expect(probed[0]).toEqual({
      baseUrl: "https://box.tail1234.ts.net",
      expectedHostId: new MachineStore(host.db).primary()!.id,
      tailnetIpv4: "100.64.0.10",
    });

    // Security invariant: Token Gate is now ON for the loopback host!
    expect(host.tokenFile).toBeDefined();
    const token = (await readFile(host.tokenFile!, "utf8")).trim();
    expect(token.length).toBeGreaterThanOrEqual(16);
    expect((await fetch(`http://127.0.0.1:${host.port}/version`)).status).toBe(
      401,
    );

    // Tailscale HTTPS Origin is allowed on /ws when authenticated, while other origins are rejected.
    const allowedWs = await connect(`ws://127.0.0.1:${host.port}/ws`, {
      origin: "https://box.tail1234.ts.net",
      "x-eta-token": token,
    });
    allowedWs.close();
    const forbidden = await fetch(`http://127.0.0.1:${host.port}/ws`, {
      headers: {
        origin: "https://evil.tail1234.ts.net",
        authorization: `Bearer ${token}`,
        upgrade: "websocket",
      },
    });
    expect(forbidden.status).toBe(403);

    // phoneLink automatically uses the active Tailscale HTTPS URL AND the live token!
    const phoneLink = (await client.call(
      "machines",
      "phoneLink",
      {},
    )) as MachineResults["phoneLink"];
    expect(phoneLink.url).toBe("https://box.tail1234.ts.net");
    const parsedLink = new URL(phoneLink.link);
    expect(parsedLink.searchParams.get("address")).toBe(
      "https://box.tail1234.ts.net",
    );
    expect(parsedLink.searchParams.get("token")).toBe(token);

    // Persisted in SQLite setting table.
    expect(readTailscaleServePreference(new SettingStore(host.db))).toEqual({
      enabled: true,
      port: 443,
    });

    // Closing the host does NOT tear down Tailscale Serve (survives restarts/upgrades).
    client.close();
    const callsBeforeClose = fake.calls.length;
    await host.close();
    expect(
      fake.calls.slice(callsBeforeClose).some((args) => args.includes("off")),
    ).toBe(false);

    // Restarting with the same dataDir enforces the Token Gate immediately and reconciles Serve!
    const restarted = await testHost({
      dataDir,
      tailscale: fake.tailscale,
      onCloudVm: false,
      tailscaleProbe: async () => true,
    });
    expect(restarted.tokenFile).toBeDefined();
    expect(
      (await fetch(`http://127.0.0.1:${restarted.port}/version`)).status,
    ).toBe(401);

    const client2 = await connect(`ws://127.0.0.1:${restarted.port}/ws`, {
      "x-eta-token": token,
    });
    await client2.hello();
    const afterRestart = (await client2.call(
      "machines",
      "addresses",
      {},
    )) as MachineResults["addresses"];
    expect(afterRestart.preferredUrl).toBe("https://box.tail1234.ts.net");
    expect(afterRestart.tailscaleServe.enabled).toBe(true);
    expect(afterRestart.tailscaleServe.activeUrl).toBe(
      "https://box.tail1234.ts.net",
    );

    // Disabling calls `tailscale serve --https=443 --set-path=/ off`, clears persistence, and unlocks loopback.
    const disabled = (await client2.call("machines", "setTailscaleServe", {
      enabled: false,
    })) as MachineResults["setTailscaleServe"];
    expect(disabled.ok).toBe(true);
    expect(disabled.preferredUrl).toBeNull();
    expect(disabled.tailscaleServe.enabled).toBe(false);
    expect(disabled.tailscaleServe.activeUrl).toBeNull();
    expect(
      fake.calls.some(
        (args) =>
          args[0] === "serve" &&
          args.includes("--https=443") &&
          args.includes("--set-path=/") &&
          args.includes("off"),
      ),
    ).toBe(true);
    expect(
      new SettingStore(restarted.db).get(TAILSCALE_SERVE_SETTING_KEY),
    ).toBeUndefined();
    expect(restarted.tokenFile).toBeUndefined();
    client2.close();
  });

  it("refuses when HTTPS is not enabled on the tailnet and keeps loopback unlocked", async () => {
    const fake = fakeTailscale({ httpsCapable: false });
    const w = await world({ tailscale: fake.tailscale, onCloudVm: false });
    const result = (await w.client.call("machines", "setTailscaleServe", {
      enabled: true,
    })) as MachineResults["setTailscaleServe"];
    expect(result.ok).toBe(false);
    expect(result.tailscaleServe.diagnostic).toBe("https-disabled");
    expect(result.tailscaleServe.httpsCapable).toBe(false);
    expect(result.tailscaleServe.error).toContain(
      "login.tailscale.com/admin/dns",
    );
    expect(w.host.tokenFile).toBeUndefined();
    expect(fake.calls.some((args) => args.includes("--bg"))).toBe(false);
  });

  it("refuses to clobber another live service on port 443 and allows succeeding on port 8443", async () => {
    const other = await occupyTcpPort();
    try {
      const fake = fakeTailscale({
        serveStatus: {
          Web: {
            "box.tail1234.ts.net:443": {
              Handlers: {
                "/": { Proxy: `http://127.0.0.1:${other.port}` },
              },
            },
          },
        },
      });
      const w = await world({
        tailscale: fake.tailscale,
        tailscaleProbe: async () => true,
        onCloudVm: false,
      });

      const conflict = (await w.client.call("machines", "setTailscaleServe", {
        enabled: true,
        port: 443,
      })) as MachineResults["setTailscaleServe"];
      expect(conflict.ok).toBe(false);
      expect(conflict.tailscaleServe.holderStatus).toBe("other");
      expect(conflict.tailscaleServe.diagnostic).toBe("port-occupied");
      expect(conflict.tailscaleServe.error).toMatch(/443/);
      expect(w.host.tokenFile).toBeUndefined();
      expect(fake.calls.some((args) => args.includes("--bg"))).toBe(false);

      // Retrying on port 8443 succeeds cleanly!
      const alt = (await w.client.call("machines", "setTailscaleServe", {
        enabled: true,
        port: 8443,
      })) as MachineResults["setTailscaleServe"];
      expect(alt.ok).toBe(true);
      expect(alt.preferredUrl).toBe("https://box.tail1234.ts.net:8443");
      expect(alt.tailscaleServe.port).toBe(8443);
      expect(w.host.tokenFile).toBeDefined();
    } finally {
      await other.close();
    }
  });

  it("omits tailnetIpv4 when Tailscale status has only IPv6 addresses", async () => {
    const fakeIpv6Only = fakeTailscale({ addresses: ["fd7a:115c:a1e0::1"] });
    const seen: Array<{ tailnetIpv4?: string }> = [];
    const w = await world({
      tailscale: fakeIpv6Only.tailscale,
      tailscaleProbe: async (input) => {
        seen.push({ tailnetIpv4: input.tailnetIpv4 });
        return true;
      },
      onCloudVm: false,
    });

    const result = (await w.client.call("machines", "setTailscaleServe", {
      enabled: true,
    })) as MachineResults["setTailscaleServe"];
    expect(result.ok).toBe(true);
    expect(seen).toEqual([{ tailnetIpv4: undefined }]);
  });

  it("rolls back Serve with holderStatus 'none' and unlocks loopback when probe fails, but reports holderStatus 'ours' and stays fail-closed if rollback fails", async () => {
    const closed = await occupyTcpPort();
    await closed.close();
    const fakeOkRollback = fakeTailscale({
      // Simulate a stale dead route before Serve so we verify post-rollback holderStatus is "none", not "dead".
      serveStatus: {
        Web: {
          "box.tail1234.ts.net:443": {
            Handlers: { "/": { Proxy: `http://127.0.0.1:${closed.port}` } },
          },
        },
      },
    });
    const w1 = await world({
      tailscale: fakeOkRollback.tailscale,
      tailscaleProbe: async () => false,
      onCloudVm: false,
    });
    const res1 = (await w1.client.call("machines", "setTailscaleServe", {
      enabled: true,
    })) as MachineResults["setTailscaleServe"];
    expect(res1.ok).toBe(false);
    expect(res1.tailscaleServe).toMatchObject({
      enabled: false,
      activeUrl: null,
      holderStatus: "none",
      diagnostic: "probe-failed",
    });
    expect(res1.tailscaleServe.error).toContain("rolled back");
    expect(res1.tailscaleServe.error).not.toContain("was configured");
    expect(fakeOkRollback.calls.some((args) => args.includes("off"))).toBe(
      true,
    );
    expect(w1.host.tokenFile).toBeUndefined();

    // Rollback fails -> Serve stays active pointing to us ("ours"), Token Gate stays ON, error says still active.
    const fakeBadRollback = fakeTailscale({
      failDisableWith: new Error("permission denied"),
    });
    const w2 = await world({
      tailscale: fakeBadRollback.tailscale,
      tailscaleProbe: async () => false,
      onCloudVm: false,
    });
    const res2 = (await w2.client.call("machines", "setTailscaleServe", {
      enabled: true,
    })) as MachineResults["setTailscaleServe"];
    expect(res2.ok).toBe(false);
    expect(res2.tailscaleServe).toMatchObject({
      enabled: false,
      activeUrl: null,
      holderStatus: "ours",
      diagnostic: "probe-failed",
    });
    expect(res2.tailscaleServe.error).toContain("still active");
    expect(res2.tailscaleServe.error).toContain("rollback failed");
    // Rollback failed -> Serve might still be forwarding -> Token Gate MUST stay ON!
    expect(w2.host.tokenFile).toBeDefined();

    // Subsequent addresses() call also reflects the active un-rolled-back route.
    const afterBadRollback = (await w2.client.call(
      "machines",
      "addresses",
      {},
    )) as MachineResults["addresses"];
    expect(afterBadRollback.tailscaleServe).toMatchObject({
      enabled: false,
      activeUrl: null,
      holderStatus: "ours",
      diagnostic: "probe-failed",
    });
  });

  it("keeps holderStatus 'ours' and stays fail-closed when Serve already pointed to us and probe fails", async () => {
    const fakeAlreadyOurs = fakeTailscale();
    const host = await testHost({
      tailscale: fakeAlreadyOurs.tailscale,
      tailscaleProbe: async () => false,
      onCloudVm: false,
    });
    // Pre-populate Serve route pointing to this exact host.
    fakeAlreadyOurs.setServeStatus({
      Web: {
        "box.tail1234.ts.net:443": {
          Handlers: { "/": { Proxy: `http://127.0.0.1:${host.port}` } },
        },
      },
    });

    const client = await connect(`ws://127.0.0.1:${host.port}/ws`);
    await client.hello();
    const res = (await client.call("machines", "setTailscaleServe", {
      enabled: true,
    })) as MachineResults["setTailscaleServe"];

    expect(res.ok).toBe(false);
    expect(res.tailscaleServe).toMatchObject({
      enabled: false,
      activeUrl: null,
      holderStatus: "ours",
      diagnostic: "probe-failed",
    });
    expect(res.tailscaleServe.error).toContain("is active");
    expect(res.tailscaleServe.error).not.toContain("rolled back");
    expect(res.tailscaleServe.error).not.toContain("rollback failed");
    expect(fakeAlreadyOurs.calls.some((args) => args.includes("off"))).toBe(
      false,
    );
    expect(host.tokenFile).toBeDefined();
    client.close();
  });

  it("reports holderStatus 'none' and rolled-back message on keepIntentOnFailure startup probe failure while keeping Token Gate ON", async () => {
    const warnings: string[] = [];
    const fake = fakeTailscale();
    const host = await testHost({
      tailscale: fake.tailscale,
      tailscaleServe: true,
      tailscaleServePort: 8443,
      tailscaleProbe: async () => false,
      onCloudVm: false,
      warn: (message) => warnings.push(message),
    });

    expect(host.tokenFile).toBeDefined();
    expect(fake.calls.some((args) => args.includes("off"))).toBe(true);
    expect(warnings.some((w) => w.includes("rolled back"))).toBe(true);

    const token = (await readFile(host.tokenFile!, "utf8")).trim();
    const client = await connect(`ws://127.0.0.1:${host.port}/ws`, {
      "x-eta-token": token,
    });
    await client.hello();
    const addresses = (await client.call(
      "machines",
      "addresses",
      {},
    )) as MachineResults["addresses"];
    expect(addresses.tailscaleServe).toMatchObject({
      enabled: true,
      activeUrl: null,
      port: 8443,
      holderStatus: "none",
      diagnostic: "probe-failed",
    });
    expect(addresses.tailscaleServe.error).toContain("rolled back");
    expect(addresses.tailscaleServe.error).not.toContain("was configured");
    client.close();
  });

  it("keeps the Token Gate on fail-closed when started with --tailscale-serve even if Tailscale is down", async () => {
    const warnings: string[] = [];
    const fake = fakeTailscale({ running: false });
    const host = await testHost({
      tailscale: fake.tailscale,
      tailscaleServe: true,
      tailscaleServePort: 8443,
      onCloudVm: false,
      warn: (message) => warnings.push(message),
    });
    expect(host.tokenFile).toBeDefined();
    expect((await fetch(`http://127.0.0.1:${host.port}/version`)).status).toBe(
      401,
    );
    expect(warnings.some((w) => w.includes("Tailscale HTTPS"))).toBe(true);
  });

  it("never calls disableServe on port 443 held by another live service after a startup conflict (both on retry to 8443 and on disable)", async () => {
    const other = await occupyTcpPort();
    try {
      const otherRoute = {
        Web: {
          "box.tail1234.ts.net:443": {
            Handlers: {
              "/": { Proxy: `http://127.0.0.1:${other.port}` },
            },
          },
        },
      };

      // Case 1: Startup fails on port 443 (held by "other"), user retries on port 8443.
      const fakeRetry = fakeTailscale({ serveStatus: otherRoute });
      const host1 = await testHost({
        tailscale: fakeRetry.tailscale,
        tailscaleServe: true,
        tailscaleServePort: 443,
        tailscaleProbe: async () => true,
        onCloudVm: false,
        warn: () => undefined,
      });
      const token1 = (await readFile(host1.tokenFile!, "utf8")).trim();
      const client1 = await connect(`ws://127.0.0.1:${host1.port}/ws`, {
        "x-eta-token": token1,
      });
      await client1.hello();
      const retried = (await client1.call("machines", "setTailscaleServe", {
        enabled: true,
        port: 8443,
      })) as MachineResults["setTailscaleServe"];
      expect(retried.ok).toBe(true);
      expect(retried.preferredUrl).toBe("https://box.tail1234.ts.net:8443");
      // Must NEVER run `tailscale serve --https=443 ... off`!
      expect(
        fakeRetry.calls.some(
          (args) => args.includes("--https=443") && args.includes("off"),
        ),
      ).toBe(false);
      client1.close();

      // Case 2: Startup fails on port 443 (held by "other"), user toggles Tailscale HTTPS off.
      const fakeDisable = fakeTailscale({ serveStatus: otherRoute });
      const host2 = await testHost({
        tailscale: fakeDisable.tailscale,
        tailscaleServe: true,
        tailscaleServePort: 443,
        tailscaleProbe: async () => true,
        onCloudVm: false,
        warn: () => undefined,
      });
      const token2 = (await readFile(host2.tokenFile!, "utf8")).trim();
      const client2 = await connect(`ws://127.0.0.1:${host2.port}/ws`, {
        "x-eta-token": token2,
      });
      await client2.hello();
      const disabled = (await client2.call("machines", "setTailscaleServe", {
        enabled: false,
      })) as MachineResults["setTailscaleServe"];
      expect(disabled.ok).toBe(true);
      expect(disabled.tailscaleServe.enabled).toBe(false);
      expect(disabled.tailscaleServe.holderStatus).toBe("other");
      expect(host2.tokenFile).toBeUndefined();
      // Must NEVER run `tailscale serve ... off` against another live service's route!
      expect(fakeDisable.calls.some((args) => args.includes("off"))).toBe(
        false,
      );
      client2.close();
    } finally {
      await other.close();
    }
  });
});
