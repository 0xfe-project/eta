/**
 * Integration tests for managed `cloudflared` tunnel wiring across `startHost`, `access.ts`,
 * `machines/plugin.ts`, and `main.ts` CLI flags.
 */
import type { TunnelChild, TunnelSpawn } from "../src/machines/tunnel";
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { connect, until } from "./support/client";
import { fakeWeb, tempDir, testHost } from "./support/host";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

class ScriptedTunnelChild extends EventEmitter implements TunnelChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: (NodeJS.Signals | number | undefined)[] = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    if (this.exitCode !== null || this.signalCode !== null) return false;
    const resolved: NodeJS.Signals =
      typeof signal === "string" ? signal : "SIGTERM";
    queueMicrotask(() => this.finish(null, resolved));
    return true;
  }

  finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", code, signal);
  }
}

async function handshake(
  url: string,
  headers: Record<string, string> = {},
): Promise<"open" | "refused"> {
  try {
    const client = await connect(url, headers);
    client.close();
    return "open";
  } catch {
    return "refused";
  }
}

describe("host with Quick Tunnel on loopback", () => {
  it("forces token auth, allows active tunnel origin only, feeds machines pairing, and stops tunnel on close", async () => {
    const tunnelUrl = "https://amber-cloud-77.trycloudflare.com";
    const child = new ScriptedTunnelChild();
    let seenArgs: readonly string[] = [];
    const spawn: TunnelSpawn = (_command, args) => {
      seenArgs = args;
      queueMicrotask(() => {
        child.stderr.write(`INF |  ${tunnelUrl}  |\n`);
      });
      return child;
    };

    const host = await testHost({
      webDir: await fakeWeb(),
      tunnel: { mode: "quick", spawn },
    });

    // Server bound an ephemeral loopback port before spawning cloudflared against it.
    expect(host.hostname).toBe("127.0.0.1");
    expect(host.port).toBeGreaterThan(0);
    expect(seenArgs).toEqual([
      "tunnel",
      "--no-autoupdate",
      "--url",
      `http://127.0.0.1:${host.port}`,
    ]);
    expect(host.tunnelUrl).toBe(tunnelUrl);

    // Token gate is forced ON even on 127.0.0.1 with no --token-file.
    expect(host.tokenFile).toBe(join(host.dataDir, "access-token"));
    if (process.platform !== "win32") {
      expect((await stat(host.tokenFile!)).mode & 0o777).toBe(0o600);
    }
    const token = (await readFile(host.tokenFile!, "utf8")).trim();
    expect(token.length).toBeGreaterThanOrEqual(16);

    const localBase = `http://127.0.0.1:${host.port}`;
    const wsUrl = `ws://127.0.0.1:${host.port}/ws`;

    // /up stays public, while pages and /ws reject unauthenticated requests.
    expect((await fetch(`${localBase}/up`)).status).toBe(200);
    expect((await fetch(`${localBase}/`)).status).toBe(401);
    expect((await fetch(`${localBase}/version`)).status).toBe(401);
    expect(await handshake(wsUrl)).toBe("refused");

    // Authenticated HTTP via Bearer and /?token= exchange behind TLS-terminating tunnel works.
    expect(
      (
        await fetch(`${localBase}/version`, {
          headers: {
            authorization: `Bearer ${token}`,
            origin: tunnelUrl,
          },
        })
      ).status,
    ).toBe(200);
    const exchanged = await fetch(`${localBase}/?token=${token}`, {
      redirect: "manual",
      headers: { "x-forwarded-proto": "https" },
    });
    expect(exchanged.status).toBe(303);
    expect(exchanged.headers.get("set-cookie")).toMatch(
      /^__Secure-eta_session=.*; Secure/,
    );

    // WebSocket accepts the active tunnel Origin (even when Host is loopback), and refuses others.
    expect(
      await handshake(wsUrl, {
        authorization: `Bearer ${token}`,
        origin: tunnelUrl,
      }),
    ).toBe("open");
    expect(
      await handshake(wsUrl, {
        authorization: `Bearer ${token}`,
        origin: "https://other-tunnel-99.trycloudflare.com",
      }),
    ).toBe("refused");
    expect(
      await handshake(wsUrl, {
        authorization: `Bearer ${token}`,
        origin: "https://evil.example",
      }),
    ).toBe("refused");

    // Machines pairing exposes tunnel in addresses and uses it in phoneLink.
    const client = await connect(wsUrl, {
      "x-eta-token": token,
      origin: tunnelUrl,
    });
    await client.hello();

    const addresses = await client.call("machines", "addresses", {});
    expect(addresses).toEqual({ tailnet: null, tunnel: tunnelUrl });

    const phone = (await client.call("machines", "phoneLink", {})) as {
      link: string;
      url: string;
    };
    expect(phone.url).toBe(tunnelUrl);
    const parsedLink = new URL(phone.link);
    expect(parsedLink.protocol).toBe("eta:");
    expect(parsedLink.searchParams.get("address")).toBe(tunnelUrl);
    expect(parsedLink.searchParams.get("token")).toBe(token);

    // Explicit URL argument still takes precedence over tunnel fallback.
    const explicit = (await client.call("machines", "phoneLink", {
      url: "https://custom.example/settings",
    })) as { link: string; url: string };
    expect(explicit.url).toBe("https://custom.example");

    client.close();

    // Closing the host stops the cloudflared child process cleanly.
    await host.close();
    expect(child.signals).toContain("SIGTERM");
    expect(child.signalCode).toBe("SIGTERM");
  });

  it("clears tunnelUrl, machines addresses/phoneLink, and revokes Quick Tunnel WS origin on unexpected exit while keeping token gate and --public-url", async () => {
    const tunnelUrl = "https://ephemeral-crash-12.trycloudflare.com";
    const publicUrl = "https://public.example.com";
    const child = new ScriptedTunnelChild();
    const warnings: string[] = [];
    const spawn: TunnelSpawn = () => {
      queueMicrotask(() => {
        child.stderr.write(`INF |  ${tunnelUrl}  |\n`);
      });
      return child;
    };

    const host = await testHost({
      publicUrl,
      tunnel: { mode: "quick", spawn },
      warn: (message) => warnings.push(message),
    });

    const token = (await readFile(host.tokenFile!, "utf8")).trim();
    const wsUrl = `ws://127.0.0.1:${host.port}/ws`;

    // While tunnel is alive, both Quick Tunnel origin and --public-url origin work.
    expect(host.tunnelUrl).toBe(tunnelUrl);
    expect(
      await handshake(wsUrl, {
        authorization: `Bearer ${token}`,
        origin: tunnelUrl,
      }),
    ).toBe("open");
    expect(
      await handshake(wsUrl, {
        authorization: `Bearer ${token}`,
        origin: publicUrl,
      }),
    ).toBe("open");

    // Simulate cloudflared crashing unexpectedly.
    child.stderr.write("ERR tunnel disconnected unexpectedly\n");
    child.finish(1, null);
    await until(() => host.tunnelUrl === undefined);

    expect(
      warnings.some((line) =>
        line.includes("tunnel disconnected unexpectedly"),
      ),
    ).toBe(true);

    // Dead Quick Tunnel origin is revoked; --public-url stays allowed; token gate remains enforced.
    expect(await handshake(wsUrl)).toBe("refused");
    expect((await fetch(`http://127.0.0.1:${host.port}/`)).status).toBe(401);
    expect(
      await handshake(wsUrl, {
        authorization: `Bearer ${token}`,
        origin: tunnelUrl,
      }),
    ).toBe("refused");
    expect(
      await handshake(wsUrl, {
        authorization: `Bearer ${token}`,
        origin: publicUrl,
      }),
    ).toBe("open");

    // machines.addresses and machines.phoneLink no longer advertise the dead tunnel URL.
    const client = await connect(wsUrl, { "x-eta-token": token });
    await client.hello();
    expect(await client.call("machines", "addresses", {})).toEqual({
      tailnet: null,
    });
    const phone = (await client.call("machines", "phoneLink", {})) as {
      link: string;
      url: string;
    };
    expect(phone.url).toBe(`http://127.0.0.1:${host.port}`);
    client.close();
  });
});

describe("host with Named Tunnel and --public-url", () => {
  it("isolates TUNNEL_TOKEN in env, gates loopback, allows publicUrl origin, and populates pairing", async () => {
    const secret = "named-tunnel-secret-value-1234";
    const child = new ScriptedTunnelChild();
    let seenArgs: readonly string[] = [];
    let seenEnv: NodeJS.ProcessEnv = {};
    const spawn: TunnelSpawn = (_command, args, options) => {
      seenArgs = args;
      seenEnv = options.env;
      queueMicrotask(() => {
        child.stderr.write("INF Registered tunnel connection connIndex=0\n");
      });
      return child;
    };

    const host = await testHost({
      publicUrl: "https://eta.example.com/ignored-path",
      tunnel: { mode: "named", token: secret, spawn },
    });

    expect(seenArgs).toEqual(["tunnel", "--no-autoupdate", "run"]);
    expect(seenArgs.join(" ")).not.toContain(secret);
    expect(seenEnv.TUNNEL_TOKEN).toBe(secret);
    expect(host.tunnelUrl).toBe("https://eta.example.com");
    expect(host.tokenFile).toBe(join(host.dataDir, "access-token"));

    const token = (await readFile(host.tokenFile!, "utf8")).trim();
    const wsUrl = `ws://127.0.0.1:${host.port}/ws`;

    expect(await handshake(wsUrl)).toBe("refused");
    expect(
      await handshake(wsUrl, {
        authorization: `Bearer ${token}`,
        origin: "https://eta.example.com",
      }),
    ).toBe("open");
    expect(
      await handshake(wsUrl, {
        authorization: `Bearer ${token}`,
        origin: "https://evil.example",
      }),
    ).toBe("refused");

    const client = await connect(wsUrl, { "x-eta-token": token });
    await client.hello();
    expect(await client.call("machines", "addresses", {})).toEqual({
      tailnet: null,
      tunnel: "https://eta.example.com",
    });
    const phone = (await client.call("machines", "phoneLink", {})) as {
      link: string;
      url: string;
    };
    expect(phone.url).toBe("https://eta.example.com");
    expect(new URL(phone.link).searchParams.get("token")).toBe(token);
    client.close();

    await host.close();
    expect(child.signalCode).toBe("SIGTERM");
  });

  it("rejects invalid --public-url early before spawning or binding a port", async () => {
    const probe = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("ok"),
    });
    const freePort = probe.port!;
    await probe.stop(true);

    let spawned = false;
    const spawn: TunnelSpawn = () => {
      spawned = true;
      return new ScriptedTunnelChild();
    };
    await expect(
      testHost({
        port: freePort,
        publicUrl: "not-a-valid-url",
        tunnel: { mode: "named", token: "valid-token", spawn },
      }),
    ).rejects.toThrow(/invalid --public-url/);
    expect(spawned).toBe(false);

    // Port was never left bound.
    const rebind = Bun.serve({
      hostname: "127.0.0.1",
      port: freePort,
      fetch: () => new Response("ok"),
    });
    expect(rebind.port).toBe(freePort);
    await rebind.stop(true);
  });

  it("cleans up server, releases the bound port, and closes DB if tunnel startup fails", async () => {
    let boundPort = 0;
    const spawn: TunnelSpawn = (_command, args) => {
      const target = args[3];
      if (target !== undefined) boundPort = Number(new URL(target).port);
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    await expect(
      testHost({ tunnel: { mode: "quick", spawn } }),
    ).rejects.toThrow(/cloudflared is not installed/);
    expect(boundPort).toBeGreaterThan(0);

    // The port bound before tunnel startup failed was released and is immediately reusable.
    const rebind = Bun.serve({
      hostname: "127.0.0.1",
      port: boundPort,
      fetch: () => new Response("ok"),
    });
    expect(rebind.port).toBe(boundPort);
    await rebind.stop(true);
  });

  it("leaves loopback ungated and omits tunnel from addresses when tunnel is off", async () => {
    const host = await testHost();
    expect(host.tokenFile).toBeUndefined();
    expect(host.tunnelUrl).toBeUndefined();
    const client = await connect(`ws://127.0.0.1:${host.port}/ws`);
    await client.hello();
    expect(await client.call("machines", "addresses", {})).toEqual({
      tailnet: null,
    });
    client.close();
  });
});

describe("eta-host CLI tunnel integration", () => {
  it.each([
    [["--port", "0", "--tunnel-token", "", "--no-llm", "--no-web"]],
    [
      [
        "--port",
        "0",
        "--tunnel",
        "--tunnel-token",
        "   ",
        "--no-llm",
        "--no-web",
      ],
    ],
  ])(
    "rejects blank --tunnel-token %j with exit code 2 without starting the host",
    async (args) => {
      const home = await tempDir("eta-cli-blank-token-");
      const run = spawnSync(process.execPath, [MAIN, ...args], {
        encoding: "utf8",
        env: { ...process.env, HOME: home, ETA_TUNNEL_TOKEN: "" },
        timeout: 30_000,
      });
      expect(run.status).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("--tunnel-token");
    },
  );

  it.skipIf(process.platform === "win32")(
    "starts with --tunnel, emits tunnelUrl JSON on stdout without leaking token, and cleans up on SIGTERM",
    async () => {
      const home = await tempDir("eta-cli-tunnel-");
      const binDir = join(home, "bin");
      await mkdir(binDir, { recursive: true });
      const fakeCloudflared = join(binDir, "cloudflared");
      const recordFile = join(home, "cloudflared-invocation.json");
      await writeFile(
        fakeCloudflared,
        `#!${process.execPath}
import { writeFileSync } from "node:fs";
import process from "node:process";
writeFileSync(${JSON.stringify(recordFile)}, JSON.stringify({
  argv: process.argv.slice(2),
  hasTunnelToken: process.env.TUNNEL_TOKEN !== undefined,
  tunnelToken: process.env.TUNNEL_TOKEN ?? null,
}));
if (process.argv.includes("run")) {
  console.error("INF Registered tunnel connection connIndex=0");
} else {
  console.error("INF |  https://cli-preview-88.trycloudflare.com  |");
}
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 10_000);
`,
        { mode: 0o755 },
      );
      await chmod(fakeCloudflared, 0o755);

      const child = nodeSpawn(
        process.execPath,
        [MAIN, "--port", "0", "--tunnel", "--no-llm", "--no-web"],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            HOME: home,
            PATH: `${binDir}:${process.env.PATH ?? ""}`,
            ETA_RELEASES_URL: "http://127.0.0.1:9/releases",
            ETA_TOKEN: "",
          },
        },
      );

      let stdout = "";
      let stderr = "";
      const readyLine = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(new Error(`timed out waiting for stdout; stderr=${stderr}`)),
          30_000,
        );
        child.stdout.on("data", (chunk: unknown) => {
          stdout += String(chunk);
          const newline = stdout.indexOf("\n");
          if (newline !== -1) {
            clearTimeout(timer);
            resolve(stdout.slice(0, newline));
          }
        });
        child.stderr.on("data", (chunk: unknown) => {
          stderr += String(chunk);
        });
        child.on("exit", (code, signal) => {
          clearTimeout(timer);
          reject(
            new Error(
              `eta-host exited early (code=${code}, signal=${signal}): ${stderr}`,
            ),
          );
        });
      });

      const summary = JSON.parse(readyLine) as {
        host: string;
        port: number;
        tokenFile: string | null;
        tunnelUrl?: string;
      };
      expect(summary.host).toBe("127.0.0.1");
      expect(summary.port).toBeGreaterThan(0);
      expect(summary.tokenFile).toBe(join(home, ".eta", "access-token"));
      expect(summary.tunnelUrl).toBe(
        "https://cli-preview-88.trycloudflare.com",
      );

      const token = (await readFile(summary.tokenFile!, "utf8")).trim();

      const invocation = JSON.parse(await readFile(recordFile, "utf8")) as {
        argv: string[];
        hasTunnelToken: boolean;
      };
      expect(invocation.argv).toEqual([
        "tunnel",
        "--no-autoupdate",
        "--url",
        `http://127.0.0.1:${summary.port}`,
      ]);
      expect(invocation.hasTunnelToken).toBe(false);

      // Clean shutdown on SIGTERM.
      child.kill("SIGTERM");
      const [code, signal] = await new Promise<
        [number | null, NodeJS.Signals | null]
      >((resolve) =>
        child.on("close", (exitCode, exitSignal) =>
          resolve([exitCode, exitSignal]),
        ),
      );
      expect({ code, signal }).toEqual({ code: 0, signal: null });
      // Pairing instructions appear on stderr without printing the raw secret token.
      expect(stderr).toContain("https://cli-preview-88.trycloudflare.com");
      expect(stderr).not.toContain(token);
      expect(stdout).not.toContain(token);
    },
    60_000,
  );

  it.skipIf(process.platform === "win32")(
    "enables named tunnel when ETA_TUNNEL_TOKEN is set and keeps token out of argv",
    async () => {
      const home = await tempDir("eta-cli-named-tunnel-");
      const binDir = join(home, "bin");
      await mkdir(binDir, { recursive: true });
      const fakeCloudflared = join(binDir, "cloudflared");
      const recordFile = join(home, "cloudflared-named.json");
      const secret = "named-env-secret-token-98765";
      await writeFile(
        fakeCloudflared,
        `#!${process.execPath}
import { writeFileSync } from "node:fs";
import process from "node:process";
writeFileSync(${JSON.stringify(recordFile)}, JSON.stringify({
  argv: process.argv.slice(2),
  tunnelToken: process.env.TUNNEL_TOKEN ?? null,
  etaTunnelToken: process.env.ETA_TUNNEL_TOKEN ?? null,
}));
console.error("INF Registered tunnel connection connIndex=0");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 10_000);
`,
        { mode: 0o755 },
      );
      await chmod(fakeCloudflared, 0o755);

      const child = nodeSpawn(
        process.execPath,
        [
          MAIN,
          "--port",
          "0",
          "--public-url",
          "https://named.example.com",
          "--no-llm",
          "--no-web",
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            HOME: home,
            PATH: `${binDir}:${process.env.PATH ?? ""}`,
            ETA_TUNNEL_TOKEN: secret,
            ETA_RELEASES_URL: "http://127.0.0.1:9/releases",
            ETA_TOKEN: "",
          },
        },
      );

      let stdout = "";
      let stderr = "";
      const readyLine = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(new Error(`timed out waiting for stdout; stderr=${stderr}`)),
          30_000,
        );
        child.stdout.on("data", (chunk: unknown) => {
          stdout += String(chunk);
          const newline = stdout.indexOf("\n");
          if (newline !== -1) {
            clearTimeout(timer);
            resolve(stdout.slice(0, newline));
          }
        });
        child.stderr.on("data", (chunk: unknown) => {
          stderr += String(chunk);
        });
        child.on("exit", (code, signal) => {
          clearTimeout(timer);
          reject(
            new Error(
              `eta-host exited early (code=${code}, signal=${signal}): ${stderr}`,
            ),
          );
        });
      });

      const summary = JSON.parse(readyLine) as {
        tokenFile: string | null;
        tunnelUrl?: string;
      };
      expect(summary.tokenFile).toBe(join(home, ".eta", "access-token"));
      expect(summary.tunnelUrl).toBe("https://named.example.com");
      expect(stdout).not.toContain(secret);
      expect(stderr).not.toContain(secret);

      const invocation = JSON.parse(await readFile(recordFile, "utf8")) as {
        argv: string[];
        tunnelToken: string | null;
        etaTunnelToken: string | null;
      };
      expect(invocation.argv).toEqual(["tunnel", "--no-autoupdate", "run"]);
      expect(invocation.argv.join(" ")).not.toContain(secret);
      expect(invocation.tunnelToken).toBe(secret);
      expect(invocation.etaTunnelToken).toBeNull();

      child.kill("SIGTERM");
      const [code, signal] = await new Promise<
        [number | null, NodeJS.Signals | null]
      >((resolve) =>
        child.on("close", (exitCode, exitSignal) =>
          resolve([exitCode, exitSignal]),
        ),
      );
      expect({ code, signal }).toEqual({ code: 0, signal: null });
      expect(stderr).toContain("https://named.example.com");
      expect(stdout).not.toContain(secret);
      expect(stderr).not.toContain(secret);
    },
    60_000,
  );
});
