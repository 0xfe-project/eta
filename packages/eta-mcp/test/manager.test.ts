/**
 * Connections: lazy start, sharing by owner, idle shutdown, lifecycle modes, backoff and the three
 * transports, against fake servers.
 */
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startFakeHttp } from "./helpers/fake-http";
import { cleanupAll, setup, tool } from "./helpers/harness";

afterEach(cleanupAll);

const spec = { tools: [tool("ping", { behavior: "counter" })] };

function text(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return result.content.map((block) => block.text ?? "").join("\n");
}

describe("lazy connection and sharing", () => {
  it("starts nothing until the first call, then reuses the connection", async () => {
    const h = await setup();
    const scope = h.manager.scope({
      owner: "a",
      sources: [h.source({ s: h.stdio(spec) })],
    });
    expect(h.starts()).toBe(0);

    const first = await scope.connect("s");
    expect(first.ok).toBe(true);
    expect(h.starts()).toBe(1);

    const [ping] = scope.tools("s") ?? [];
    expect(ping?.name).toBe("ping");
    const a = await scope.callTool("s", ping!, {});
    const b = await scope.callTool("s", ping!, {});
    expect(text(a)).toBe("count 1");
    expect(text(b)).toBe("count 2");
    expect(h.starts()).toBe(1);
  });

  it("shares one connection between scopes of an owner and never between owners", async () => {
    const h = await setup();
    const sources = [h.source({ s: h.stdio(spec) })];
    const one = h.manager.scope({ owner: "agent-1", sources });
    const two = h.manager.scope({ owner: "agent-1", sources });
    const other = h.manager.scope({ owner: "agent-2", sources });

    await one.connect("s");
    await two.connect("s");
    expect(h.starts()).toBe(1);
    const [ping] = one.tools("s") ?? [];
    expect(text(await one.callTool("s", ping!, {}))).toBe("count 1");
    expect(text(await two.callTool("s", ping!, {}))).toBe("count 2");

    await other.connect("s");
    expect(h.starts()).toBe(2);
    expect(text(await other.callTool("s", ping!, {}))).toBe("count 1");
  });

  it("shares one attempt between concurrent callers", async () => {
    const h = await setup();
    const scope = h.manager.scope({
      owner: "a",
      sources: [h.source({ s: h.stdio(spec) })],
    });
    await Promise.all([
      scope.connect("s"),
      scope.connect("s"),
      scope.connect("s"),
    ]);
    expect(h.starts()).toBe(1);
  });

  it("closing a server leaves alone a connection made while it was closing", async () => {
    const h = await setup();
    const scope = h.manager.scope({
      owner: "a",
      sources: [h.source({ s: h.stdio(spec) })],
    });
    await scope.connect("s");

    // The close is under way (the old process is being stopped) when the next caller connects.
    const closing = h.manager.servers.close("a", "s");
    const next = scope.connect("s");
    await closing;
    expect(await next).toMatchObject({ ok: true });
    expect(h.manager.servers.get("a", "s")?.status).toBe("connected");
    expect(h.starts()).toBe(2);
  });

  it("reconnects with a changed config", async () => {
    const h = await setup();
    const scope = h.manager.scope({
      owner: "a",
      sources: [h.source({ s: h.stdio(spec) })],
    });
    await scope.connect("s");
    scope.setSources([h.source({ s: h.stdio(spec, {}, { EXTRA: "1" }) })]);
    await scope.connect("s");
    expect(h.starts()).toBe(2);
  });
});

describe("idle shutdown and lifecycle", () => {
  it("closes an idle lazy server after 10 minutes and starts it again on the next call", async () => {
    const h = await setup();
    const scope = h.manager.scope({
      owner: "a",
      sources: [h.source({ s: h.stdio(spec) })],
    });
    const [ping] =
      (await scope.toolsOrConnect("s").then((o) => (o.ok ? o.tools : []))) ??
      [];

    h.advance(9 * 60_000);
    await h.manager.sweep();
    expect(h.manager.servers.get("a", "s")?.status).toBe("connected");

    h.advance(2 * 60_000);
    await h.manager.sweep();
    expect(h.manager.servers.get("a", "s")).toBeUndefined();
    // Still searchable, and the next call starts it again.
    expect(scope.tools("s")?.map((t) => t.name)).toEqual(["ping"]);
    expect(text(await scope.callTool("s", ping!, {}))).toBe("count 1");
    expect(h.starts()).toBe(2);
  });

  it("does not close a server with a call in flight", async () => {
    const h = await setup();
    const slow = { tools: [tool("slow", { behavior: "sleep", ms: 300 })] };
    const scope = h.manager.scope({
      owner: "a",
      sources: [h.source({ s: h.stdio(slow) })],
    });
    await scope.connect("s");
    const [slowTool] = scope.tools("s") ?? [];
    const running = scope.callTool("s", slowTool!, {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    h.advance(20 * 60_000);
    await h.manager.sweep();
    expect(h.manager.servers.get("a", "s")?.status).toBe("connected");
    expect(text(await running)).toBe("slept");
  });

  it("honours a per-server idleTimeout in minutes, and 0 for never", async () => {
    const h = await setup();
    const scope = h.manager.scope({
      owner: "a",
      sources: [
        h.source({
          short: h.stdio(spec, { idleTimeout: 1 }),
          never: h.stdio(spec, { idleTimeout: 0 }),
        }),
      ],
    });
    await scope.connect("short");
    await scope.connect("never");
    h.advance(2 * 60_000);
    await h.manager.sweep();
    expect(h.manager.servers.get("a", "short")).toBeUndefined();
    h.advance(24 * 60 * 60_000);
    await h.manager.sweep();
    expect(h.manager.servers.get("a", "never")?.status).toBe("connected");
  });

  it("keep-alive connects at start, never idles out, and reconnects when it drops", async () => {
    const h = await setup();
    const scope = h.manager.scope({
      owner: "a",
      sources: [
        h.source({
          s: h.stdio(
            { tools: [tool("die", { behavior: "crash" }), tool("ok")] },
            { lifecycle: "keep-alive" },
          ),
        }),
      ],
    });
    expect(h.starts()).toBe(0);
    await scope.start();
    expect(h.starts()).toBe(1);

    h.advance(60 * 60_000);
    await h.manager.sweep();
    expect(h.manager.servers.get("a", "s")?.status).toBe("connected");

    const die = scope.tools("s")!.find((t) => t.name === "die")!;
    const result = await scope.callTool("s", die, {});
    expect(result.isError).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.manager.servers.get("a", "s")?.status).not.toBe("connected");

    await h.manager.sweep();
    expect(h.manager.servers.get("a", "s")?.status).toBe("connected");
    expect(h.starts()).toBe(2);
  });

  it("lazy-keep-alive waits for the first use, then stays up and comes back", async () => {
    const h = await setup();
    const scope = h.manager.scope({
      owner: "a",
      sources: [
        h.source({
          s: h.stdio(
            { tools: [tool("die", { behavior: "crash" })] },
            { lifecycle: "lazy-keep-alive" },
          ),
        }),
      ],
    });
    await scope.start();
    expect(h.starts()).toBe(0);
    await scope.connect("s");
    expect(h.starts()).toBe(1);
    h.advance(60 * 60_000);
    await h.manager.sweep();
    expect(h.manager.servers.get("a", "s")?.status).toBe("connected");

    const die = scope.tools("s")![0]!;
    await scope.callTool("s", die, {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    await h.manager.sweep();
    expect(h.starts()).toBe(2);
  });

  it("closing an owner stops its servers", async () => {
    const h = await setup();
    const scope = h.manager.scope({
      owner: "a",
      sources: [h.source({ s: h.stdio(spec) })],
    });
    await scope.connect("s");
    await h.manager.closeOwner("a");
    expect(h.manager.servers.get("a", "s")).toBeUndefined();
  });
});

describe("failure backoff", () => {
  it("fails fast for a minute after a failed start, then tries again", async () => {
    const h = await setup();
    const scope = h.manager.scope({
      owner: "a",
      sources: [
        h.source({
          s: h.stdio(
            spec,
            {},
            { FAKE_MCP_FAIL: "1", FAKE_MCP_STDERR: "boom: missing key" },
          ),
        }),
      ],
    });
    const first = await scope.connect("s");
    expect(first.ok).toBe(false);
    expect(first.ok === false && first.message).toContain("boom: missing key");
    expect(h.starts()).toBe(1);

    const second = await scope.connect("s");
    expect(second).toMatchObject({ ok: false, error: "server_backoff" });
    expect(h.starts()).toBe(1);
    expect(scope.status()[0]).toMatchObject({ state: "failed" });

    // An explicit connect ignores the window.
    await scope.connect("s", { force: true });
    expect(h.starts()).toBe(2);

    h.advance(61_000);
    await scope.connect("s");
    expect(h.starts()).toBe(3);
  });

  it("answers a call during backoff without trying again", async () => {
    const h = await setup();
    const scope = h.manager.scope({
      owner: "a",
      sources: [h.source({ s: h.stdio(spec, {}, { FAKE_MCP_FAIL: "1" }) })],
    });
    const fake = {
      name: "ping",
      description: "",
      inputSchema: { type: "object" },
    };
    const first = await scope.callTool("s", fake, {});
    expect(first.details).toMatchObject({
      error: "connect_failed",
      delivery: "not_sent",
    });
    const second = await scope.callTool("s", fake, {});
    expect(second.details).toMatchObject({
      error: "server_backoff",
      delivery: "not_sent",
    });
    expect(h.starts()).toBe(1);
  });
});

describe("transports", () => {
  it("speaks streamable HTTP", async () => {
    const h = await setup();
    const http = await startFakeHttp({ spec });
    try {
      const scope = h.manager.scope({
        owner: "a",
        sources: [h.source({ web: { url: http.url } })],
      });
      expect((await scope.connect("web")).ok).toBe(true);
      const [ping] = scope.tools("web")!;
      expect(text(await scope.callTool("web", ping!, {}))).toBe("count 1");
      expect(http.calls).toEqual(["ping"]);
    } finally {
      await h.manager.closeAll();
      await http.close();
    }
  });

  it("falls back to legacy SSE when the endpoint is not streamable HTTP", async () => {
    const h = await setup();
    const http = await startFakeHttp({ spec, mode: "sse-only" });
    try {
      // No pinned type: the URL is tried as streamable HTTP first, answers 404
      // like a legacy server, and the same URL is then opened as SSE.
      const scope = h.manager.scope({
        owner: "a",
        sources: [h.source({ old: { url: http.sseUrl } })],
      });
      expect((await scope.connect("old")).ok).toBe(true);
      const [ping] = scope.tools("old")!;
      expect(text(await scope.callTool("old", ping!, {}))).toBe("count 1");
      const sse = new URL(http.sseUrl).pathname;
      const tried = http.requests
        .filter((request) => request.path === sse)
        .map((request) => request.method);
      expect(tried.slice(0, 2)).toEqual(["POST", "GET"]);
    } finally {
      await h.manager.closeAll();
      await http.close();
    }
  });

  it("sends configured headers and bearer tokens", async () => {
    const h = await setup({ env: { TOKEN_VAR: "from-env" } });
    const http = await startFakeHttp({ spec, bearer: "secret" });
    try {
      const scope = h.manager.scope({
        owner: "a",
        sources: [
          h.source({
            good: {
              url: http.url,
              auth: "bearer",
              bearerToken: "secret",
              // eslint-disable-next-line no-template-curly-in-string -- the library interpolates this
              headers: { "x-who": "${TOKEN_VAR}" },
            },
            bad: { url: http.url },
          }),
        ],
      });
      expect((await scope.connect("good")).ok).toBe(true);
      const sent = http.requests.find(
        (request) => request.headers["x-who"] !== undefined,
      );
      expect(sent?.headers["x-who"]).toBe("from-env");
      expect(sent?.headers.authorization).toBe("Bearer secret");

      const denied = await scope.connect("bad");
      expect(denied).toMatchObject({ ok: false, error: "needs_auth" });
      expect(
        scope.status().find((status) => status.name === "bad")?.state,
      ).toBe("needs-auth");
    } finally {
      await h.manager.closeAll();
      await http.close();
    }
  });

  it("asks authProviderFor for auth: oauth and reports needs-auth without one", async () => {
    const asked: string[] = [];
    const h = await setup({
      authProviderFor: (key) => {
        asked.push(key);
        return undefined;
      },
    });
    const http = await startFakeHttp({ spec });
    try {
      const scope = h.manager.scope({
        owner: "a",
        sources: [h.source({ remote: { url: http.url, auth: "oauth" } })],
      });
      const outcome = await scope.connect("remote");
      expect(asked).toEqual(["remote"]);
      expect(outcome).toMatchObject({ ok: false, error: "needs_auth" });
      expect(http.requests).toHaveLength(0);
    } finally {
      await h.manager.closeAll();
      await http.close();
    }
  });
});

describe("the child process", () => {
  const probes = {
    tools: [
      tool("cwd", { behavior: "cwd" }),
      tool("env", {
        behavior: "env",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
        },
      }),
    ],
  };

  async function probe(
    h: Awaited<ReturnType<typeof setup>>,
    entry: Parameters<typeof h.stdio>[1],
    cwd?: string,
  ) {
    const scope = h.manager.scope({
      owner: "a",
      sources: [h.source({ s: h.stdio(probes, entry) })],
      ...(cwd ? { cwd } : {}),
    });
    expect(await scope.connect("s")).toMatchObject({ ok: true });
    const read = async (name: string, args: Record<string, unknown> = {}) =>
      text(
        await scope.callTool(
          "s",
          scope.tools("s")!.find((t) => t.name === name)!,
          args,
        ),
      );
    return { scope, read };
  }

  it("starts in the session's directory unless the config names one", async () => {
    const h = await setup();
    const sessionDir = await mkdtemp(join(tmpdir(), "eta-mcp-cwd-"));
    const configured = await mkdtemp(join(tmpdir(), "eta-mcp-cwd-"));
    try {
      const inSession = await probe(h, {}, sessionDir);
      expect(await inSession.read("cwd")).toBe(await realpath(sessionDir));
      await h.manager.closeAll();

      const h2 = await setup();
      const inConfig = await probe(h2, { cwd: configured }, sessionDir);
      expect(await inConfig.read("cwd")).toBe(await realpath(configured));
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
      await rm(configured, { recursive: true, force: true });
    }
  });

  it("gets only the basic environment plus what the config adds, with variables filled in", async () => {
    const h = await setup({
      env: {
        HOST_SECRET: "leak",
        FROM_HOST: "hello",
        PATH: process.env.PATH ?? "",
      },
    });
    // eslint-disable-next-line no-template-curly-in-string -- the library interpolates this
    const { read } = await probe(h, { env: { ADDED: "${FROM_HOST} there" } });
    expect(await read("env", { name: "HOST_SECRET" })).toBe("");
    expect(await read("env", { name: "ADDED" })).toBe("hello there");
    expect(await read("env", { name: "PATH" })).not.toBe("");
  });

  it("gets the host's whole environment with inheritEnv", async () => {
    const h = await setup({
      env: { HOST_SECRET: "shared", PATH: process.env.PATH ?? "" },
    });
    const { read } = await probe(h, { inheritEnv: true });
    expect(await read("env", { name: "HOST_SECRET" })).toBe("shared");
  });
});

describe("timers and recovery", () => {
  it("closes idle servers on its own timer", async () => {
    const h = await setup({
      checkIntervalMs: 25,
      idleTimeoutMs: 80,
      now: undefined,
    });
    const scope = h.manager.scope({
      owner: "a",
      sources: [h.source({ s: h.stdio(spec) })],
    });
    await scope.connect("s");
    expect(h.manager.servers.get("a", "s")?.status).toBe("connected");
    await vi.waitFor(
      () => expect(h.manager.servers.get("a", "s")).toBeUndefined(),
      { timeout: 3000 },
    );
    expect(scope.tools("s")).toHaveLength(1);
  });

  it("starts a new session when the HTTP server forgot the old one, and the call runs once", async () => {
    const h = await setup();
    const http = await startFakeHttp({ spec });
    try {
      const scope = h.manager.scope({
        owner: "a",
        sources: [h.source({ web: { url: http.url } })],
      });
      await scope.connect("web");
      const [ping] = scope.tools("web")!;
      expect(text(await scope.callTool("web", ping!, {}))).toBe("count 1");

      http.forgetSessions();
      const result = await scope.callTool("web", ping!, {});
      expect(result.isError).toBeUndefined();
      expect(http.sessions()).toBe(2);
      expect(http.calls).toEqual(["ping", "ping"]);
    } finally {
      await h.manager.closeAll();
      await http.close();
    }
  });

  it("reads a bearer token from the environment", async () => {
    const h = await setup({ env: { MY_TOKEN: "from-env" } });
    const http = await startFakeHttp({ spec, bearer: "from-env" });
    try {
      const scope = h.manager.scope({
        owner: "a",
        sources: [
          h.source({
            web: { url: http.url, auth: "bearer", bearerTokenEnv: "MY_TOKEN" },
          }),
        ],
      });
      expect((await scope.connect("web")).ok).toBe(true);
    } finally {
      await h.manager.closeAll();
      await http.close();
    }
  });
});
