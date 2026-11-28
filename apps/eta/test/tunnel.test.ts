/**
 * Unit tests for the managed `cloudflared` tunnel runner (`apps/eta/src/machines/tunnel.ts`).
 *
 * Uses an injectable fake `spawn` so tests run fast and deterministically without requiring
 * network access or a real `cloudflared` binary, plus one real child-process teardown test.
 */
import type { TunnelChild, TunnelSpawn } from "../src/machines/tunnel";
import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import process from "node:process";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  extractQuickTunnelUrl,
  isNamedTunnelReadyLine,
  normalizeTunnelPublicUrl,
  startCloudflaredTunnel,
} from "../src/machines/tunnel";

class FakeTunnelChild extends EventEmitter implements TunnelChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: (NodeJS.Signals | number | undefined)[] = [];
  readonly #ignoreSigterm: boolean;

  constructor(options: { ignoreSigterm?: boolean } = {}) {
    super();
    this.#ignoreSigterm = options.ignoreSigterm === true;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    if (this.exitCode !== null || this.signalCode !== null) return false;
    if (signal === "SIGTERM" && this.#ignoreSigterm) return true;
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

interface SpawnCall {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}

describe("extractQuickTunnelUrl", () => {
  it("parses standard cloudflared banner lines and bare URLs", () => {
    expect(
      extractQuickTunnelUrl(
        "2026-11-28T13:00:00Z INF |  https://gentle-river-1234.trycloudflare.com  |",
      ),
    ).toBe("https://gentle-river-1234.trycloudflare.com");
    expect(
      extractQuickTunnelUrl(
        "https://UPPER-Case-42.trycloudflare.com/some/path",
      ),
    ).toBe("https://upper-case-42.trycloudflare.com");
  });

  it("parses structured JSON log lines including escaped slashes", () => {
    expect(
      extractQuickTunnelUrl(
        JSON.stringify({
          level: "info",
          time: "2026-11-28T13:00:00Z",
          message: "|  https://json-tunnel-abc.trycloudflare.com  |",
        }),
      ),
    ).toBe("https://json-tunnel-abc.trycloudflare.com");
    expect(
      extractQuickTunnelUrl(
        '{"level":"info","url":"https:\\/\\/escaped-slug.trycloudflare.com"}',
      ),
    ).toBe("https://escaped-slug.trycloudflare.com");
  });

  it("ignores reserved Cloudflare API hostnames and unrelated lines", () => {
    expect(
      extractQuickTunnelUrl(
        "INF Requesting new quick Tunnel on https://api.trycloudflare.com/tunnel",
      ),
    ).toBeUndefined();
    expect(
      extractQuickTunnelUrl("https://www.trycloudflare.com"),
    ).toBeUndefined();
    expect(
      extractQuickTunnelUrl("https://evil.trycloudflare.com.attacker.test"),
    ).toBeUndefined();
    expect(extractQuickTunnelUrl("https://example.com")).toBeUndefined();
    expect(extractQuickTunnelUrl("")).toBeUndefined();
  });
});

describe("isNamedTunnelReadyLine", () => {
  it("matches text and JSON connection registration lines", () => {
    expect(
      isNamedTunnelReadyLine(
        "2026-11-28T13:00:00Z INF Registered tunnel connection connIndex=0 connection=abc",
      ),
    ).toBe(true);
    expect(
      isNamedTunnelReadyLine(
        JSON.stringify({
          level: "info",
          message: "Registered tunnel connection",
          connIndex: 0,
        }),
      ),
    ).toBe(true);
    expect(isNamedTunnelReadyLine("INF Connection 1234-5678 registered")).toBe(
      true,
    );
    expect(isNamedTunnelReadyLine("INF Starting tunnel")).toBe(false);
  });
});

describe("normalizeTunnelPublicUrl", () => {
  it("normalizes valid http(s) URLs to their origin and rejects others", () => {
    expect(normalizeTunnelPublicUrl("https://eta.example.com/app?x=1")).toBe(
      "https://eta.example.com",
    );
    expect(normalizeTunnelPublicUrl("http://eta.example.com:8443/")).toBe(
      "http://eta.example.com:8443",
    );
    expect(() => normalizeTunnelPublicUrl("not a url")).toThrow(
      /invalid --public-url/,
    );
    expect(() => normalizeTunnelPublicUrl("ftp://eta.example.com")).toThrow(
      /http or https/,
    );
  });
});

describe("startCloudflaredTunnel (Quick Tunnel)", () => {
  it("spawns cloudflared against loopback target and parses stderr banner URL", async () => {
    const child = new FakeTunnelChild();
    const calls: SpawnCall[] = [];
    const spawn: TunnelSpawn = (command, args, options) => {
      calls.push({ command, args, env: options.env });
      queueMicrotask(() => {
        child.stderr.write(
          "2026-11-28T13:00:00Z INF Requesting new quick Tunnel on https://api.trycloudflare.com\n",
        );
        child.stderr.write(
          "2026-11-28T13:00:01Z INF |  https://sunny-cedar-42.trycloudflare.com  |\n",
        );
      });
      return child;
    };

    const tunnel = await startCloudflaredTunnel({
      config: { mode: "quick" },
      targetUrl: "http://127.0.0.1:18788",
      env: {
        PATH: "/usr/bin",
        TUNNEL_TOKEN: "ambient-should-be-cleared",
        ETA_TUNNEL_TOKEN: "eta-ambient-should-be-cleared",
      },
      spawn,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("cloudflared");
    expect(calls[0]!.args).toEqual([
      "tunnel",
      "--no-autoupdate",
      "--url",
      "http://127.0.0.1:18788",
    ]);
    expect(calls[0]!.env.TUNNEL_TOKEN).toBeUndefined();
    expect(calls[0]!.env.ETA_TUNNEL_TOKEN).toBeUndefined();
    expect(tunnel.mode).toBe("quick");
    expect(tunnel.url).toBe("https://sunny-cedar-42.trycloudflare.com");

    await tunnel.stop();
    expect(child.signals).toEqual(["SIGTERM"]);
    // Calling stop() again is idempotent.
    await tunnel.stop();
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("parses chunked JSON URLs emitted on stdout", async () => {
    const child = new FakeTunnelChild();
    const spawn: TunnelSpawn = () => {
      queueMicrotask(() => {
        child.stdout.write('{"level":"info","url":"https://split-');
        child.stdout.write('chunk-99.trycloudflare.com"}\n');
      });
      return child;
    };

    const tunnel = await startCloudflaredTunnel({
      config: { mode: "quick" },
      targetUrl: "http://127.0.0.1:18788",
      spawn,
    });
    expect(tunnel.url).toBe("https://split-chunk-99.trycloudflare.com");
    await tunnel.stop();
  });

  it("surfaces a clear actionable error when cloudflared is missing (ENOENT)", async () => {
    const asyncSpawn: TunnelSpawn = () => {
      const child = new FakeTunnelChild();
      queueMicrotask(() => {
        const err = Object.assign(new Error("spawn cloudflared ENOENT"), {
          code: "ENOENT",
        });
        child.emit("error", err);
      });
      return child;
    };
    await expect(
      startCloudflaredTunnel({
        config: { mode: "quick" },
        targetUrl: "http://127.0.0.1:18788",
        spawn: asyncSpawn,
      }),
    ).rejects.toThrow(/cloudflared is not installed or not on PATH/);

    const syncSpawn: TunnelSpawn = () => {
      throw Object.assign(new Error("spawn cloudflared ENOENT"), {
        code: "ENOENT",
      });
    };
    await expect(
      startCloudflaredTunnel({
        config: { mode: "quick" },
        targetUrl: "http://127.0.0.1:18788",
        binary: "/missing/cloudflared",
        spawn: syncSpawn,
      }),
    ).rejects.toThrow(/\/missing\/cloudflared/);
  });

  it("rejects with stderr detail when cloudflared exits prematurely", async () => {
    const spawn: TunnelSpawn = () => {
      const child = new FakeTunnelChild();
      queueMicrotask(() => {
        child.stderr.write(
          "ERR failed to request quick tunnel: rate limited\n",
        );
        child.finish(1, null);
      });
      return child;
    };

    await expect(
      startCloudflaredTunnel({
        config: { mode: "quick" },
        targetUrl: "http://127.0.0.1:18788",
        spawn,
      }),
    ).rejects.toThrow(
      /exited before tunnel was ready \(exit code 1\).*rate limited/,
    );
  });

  it("enforces startup timeout and stops the hung child process", async () => {
    const child = new FakeTunnelChild();
    const spawn: TunnelSpawn = () => child;

    await expect(
      startCloudflaredTunnel({
        config: { mode: "quick" },
        targetUrl: "http://127.0.0.1:18788",
        startupTimeoutMs: 40,
        stopGraceMs: 40,
        spawn,
      }),
    ).rejects.toThrow(/timed out waiting for cloudflared tunnel after 40ms/);
    expect(child.signals).toContain("SIGTERM");
    expect(child.signalCode).toBe("SIGTERM");
  });
});

describe("startCloudflaredTunnel (Named Tunnel)", () => {
  it("passes token strictly via TUNNEL_TOKEN env (never argv) and uses normalized publicUrl", async () => {
    const secret = "eyJhIjoiMTIzNCIsInQiOiJzZWNyZXQtdG9rZW4tOTk5OSJ9";
    const child = new FakeTunnelChild();
    const calls: SpawnCall[] = [];
    const spawn: TunnelSpawn = (command, args, options) => {
      calls.push({ command, args, env: options.env });
      queueMicrotask(() => {
        child.stderr.write(
          "2026-11-28T13:00:00Z INF Registered tunnel connection connIndex=0\n",
        );
      });
      return child;
    };

    const warnings: string[] = [];
    const tunnel = await startCloudflaredTunnel({
      config: {
        mode: "named",
        token: secret,
        publicUrl: "https://eta.example.com/workspace",
      },
      targetUrl: "http://127.0.0.1:18788",
      env: { PATH: "/usr/bin", ETA_TUNNEL_TOKEN: secret },
      spawn,
      warn: (message) => warnings.push(message),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(["tunnel", "--no-autoupdate", "run"]);
    expect(calls[0]!.args.join(" ")).not.toContain(secret);
    expect(calls[0]!.env.TUNNEL_TOKEN).toBe(secret);
    expect(calls[0]!.env.ETA_TUNNEL_TOKEN).toBeUndefined();
    expect(tunnel.mode).toBe("named");
    expect(tunnel.url).toBe("https://eta.example.com");
    expect(warnings).toEqual([]);

    await tunnel.stop();
  });

  it("warns cleanly when started without --public-url and resolves with url undefined", async () => {
    const child = new FakeTunnelChild();
    const warnings: string[] = [];
    const spawn: TunnelSpawn = () => {
      queueMicrotask(() => {
        child.stderr.write(
          `${JSON.stringify({
            level: "info",
            message: "Registered tunnel connection",
          })}\n`,
        );
      });
      return child;
    };

    const tunnel = await startCloudflaredTunnel({
      config: { mode: "named", token: "named-token-value" },
      targetUrl: "http://127.0.0.1:18788",
      spawn,
      warn: (message) => warnings.push(message),
    });
    expect(tunnel.url).toBeUndefined();
    expect(warnings.some((line) => line.includes("--public-url"))).toBe(true);
    await tunnel.stop();
  });

  it("redacts the tunnel token if cloudflared echoes it before exiting", async () => {
    const secret = "super-secret-named-tunnel-token";
    const spawn: TunnelSpawn = () => {
      const child = new FakeTunnelChild();
      queueMicrotask(() => {
        child.stderr.write(`ERR invalid token ${secret}\n`);
        child.finish(1, null);
      });
      return child;
    };

    let caught: Error | undefined;
    try {
      await startCloudflaredTunnel({
        config: {
          mode: "named",
          token: secret,
          publicUrl: "https://eta.example.com",
        },
        targetUrl: "http://127.0.0.1:18788",
        spawn,
      });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).not.toContain(secret);
    expect(caught!.message).toContain("***");
  });

  it("rejects empty tokens and invalid publicUrl before spawning", async () => {
    let spawned = false;
    const spawn: TunnelSpawn = () => {
      spawned = true;
      return new FakeTunnelChild();
    };
    await expect(
      startCloudflaredTunnel({
        config: { mode: "named", token: "   " },
        targetUrl: "http://127.0.0.1:18788",
        spawn,
      }),
    ).rejects.toThrow(/non-empty token/);
    await expect(
      startCloudflaredTunnel({
        config: {
          mode: "named",
          token: "valid-token",
          publicUrl: "not-a-valid-url",
        },
        targetUrl: "http://127.0.0.1:18788",
        spawn,
      }),
    ).rejects.toThrow(/invalid --public-url/);
    expect(spawned).toBe(false);
  });
});

describe("teardown", () => {
  it("warns with redacted stderr, invokes onExit, and keeps stop() safe on unexpected post-startup exit", async () => {
    const secret = "post-startup-secret-token-42";
    const child = new FakeTunnelChild();
    const warnings: string[] = [];
    let exitDetails:
      | { code: number | null; signal: NodeJS.Signals | null }
      | undefined;
    let resolveExited!: () => void;
    const exitedPromise = new Promise<void>((resolve) => {
      resolveExited = resolve;
    });

    const spawn: TunnelSpawn = () => {
      queueMicrotask(() => {
        child.stderr.write("INF Registered tunnel connection connIndex=0\n");
      });
      return child;
    };

    const tunnel = await startCloudflaredTunnel({
      config: {
        mode: "named",
        token: secret,
        publicUrl: "https://eta.example.com",
      },
      targetUrl: "http://127.0.0.1:18788",
      spawn,
      warn: (message) => warnings.push(message),
      onExit: (details) => {
        exitDetails = details;
        resolveExited();
      },
    });

    // Simulate unexpected crash after startup with secret echoed in final stderr line.
    child.stderr.write(`ERR connection lost for ${secret}\n`);
    child.finish(1, null);
    await exitedPromise;

    expect(exitDetails).toEqual({ code: 1, signal: null });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("exited unexpectedly (exit code 1)");
    expect(warnings[0]).toContain("connection lost for ***");
    expect(warnings[0]).not.toContain(secret);

    // Subsequent stop() resolves cleanly without attempting to signal an exited child.
    await tunnel.stop();
    expect(child.signals).toEqual([]);
  });

  it("escalates from SIGTERM to SIGKILL after stopGraceMs when process refuses SIGTERM", async () => {
    const child = new FakeTunnelChild({ ignoreSigterm: true });
    const spawn: TunnelSpawn = () => {
      queueMicrotask(() => {
        child.stderr.write("INF |  https://stubborn-42.trycloudflare.com  |\n");
      });
      return child;
    };

    const tunnel = await startCloudflaredTunnel({
      config: { mode: "quick" },
      targetUrl: "http://127.0.0.1:18788",
      stopGraceMs: 30,
      spawn,
    });
    await tunnel.stop();
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.signalCode).toBe("SIGKILL");
  });

  it.skipIf(process.platform === "win32")(
    "stops a real child process cleanly without leaving orphans",
    async () => {
      const script = [
        'console.error("INF |  https://real-child-test.trycloudflare.com  |");',
        "setInterval(() => {}, 10_000);",
      ].join(" ");
      const tunnel = await startCloudflaredTunnel({
        config: { mode: "quick" },
        targetUrl: "http://127.0.0.1:18788",
        binary: process.execPath,
        spawn: (command, _args, options) => {
          // Run bun itself with a tiny script that prints a quick-tunnel URL and stays alive.
          return startRealBunChild(command, script, options.env);
        },
      });
      expect(tunnel.url).toBe("https://real-child-test.trycloudflare.com");
      await tunnel.stop();
    },
  );
});

function startRealBunChild(
  binary: string,
  code: string,
  env: NodeJS.ProcessEnv,
): TunnelChild {
  return nodeSpawn(binary, ["-e", code], {
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
}
