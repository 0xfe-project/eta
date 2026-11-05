import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServerSpec } from "../src";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { McpError, McpServers, needsOAuth } from "../src";

const fixture = join(import.meta.dirname, "fixtures/server.mjs");
const opened: McpServers[] = [];
const dirs: string[] = [];
const http: Server[] = [];

function serversOf(
  servers: McpServerSpec[],
  options: Partial<ConstructorParameters<typeof McpServers>[0]> = {},
): McpServers {
  const made = new McpServers({ servers, ...options });
  opened.push(made);
  return made;
}

const stdio = (
  env: Record<string, string> = {},
  name = "fixture",
): McpServerSpec => ({
  name,
  command: process.execPath,
  args: [fixture],
  env: { BUN_BE_BUN: "1", ...env },
});

const dir = (): string => {
  const made = mkdtempSync(join(tmpdir(), "eta-mcp-"));
  dirs.push(made);
  return made;
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const failureOf = async (work: Promise<unknown>): Promise<McpError> => {
  const error = await work.then(
    () => new Error("expected a failure"),
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(McpError);
  return error as McpError;
};

/** A remote server that speaks just enough of streamable HTTP, or answers 401 without `key`. */
async function remote(
  key?: string,
): Promise<{ url: string; seen: Record<string, string | undefined>[] }> {
  const seen: Record<string, string | undefined>[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += String(chunk)));
    request.on("end", () => {
      seen.push({
        authorization: request.headers.authorization,
        method: request.method,
      });
      if (key !== undefined && request.headers.authorization !== key) {
        response.writeHead(401, {
          "www-authenticate": 'Bearer resource_metadata="http://x/.well-known"',
        });
        response.end();
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405);
        response.end();
        return;
      }
      const { id, method, params } = JSON.parse(body) as {
        id?: number;
        method: string;
        params: { protocolVersion?: string; name?: string };
      };
      if (id === undefined) {
        response.writeHead(202);
        response.end();
        return;
      }
      const result =
        method === "initialize"
          ? {
              protocolVersion: params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "remote", version: "1.0.0" },
            }
          : method === "tools/list"
            ? {
                tools: [
                  {
                    name: "ping",
                    description: "Ping.",
                    inputSchema: { type: "object" },
                  },
                ],
              }
            : { content: [{ type: "text", text: `pong ${params.name}` }] };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  http.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp`, seen };
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((one) => one.close()));
  for (const server of http.splice(0)) server.close();
  for (const made of dirs.splice(0))
    rmSync(made, { recursive: true, force: true });
});

describe("a stdio server", () => {
  it("does not start until something needs it, and gets its environment", async () => {
    const servers = serversOf([stdio({ FIXTURE_VALUE: "configured" })]);
    expect(servers.known("fixture")).toBeUndefined();
    expect(await servers.call("fixture", "env", {})).toMatch(
      /^configured:\d+$/,
    );
    expect(servers.known("fixture")?.map((tool) => tool.name)).toContain("env");
  });

  it("shares one process between calls that arrive together", async () => {
    const servers = serversOf([stdio()]);
    const answers = await Promise.all([
      servers.call("fixture", "env", {}),
      servers.call("fixture", "env", {}),
    ]);
    expect(answers[0]).toBe(answers[1]);
  });

  it("exits when the session closes", async () => {
    const servers = serversOf([stdio()]);
    const answer = (await servers.call("fixture", "env", {})) as string;
    const pid = Number(answer.split(":")[1]);
    expect(alive(pid)).toBe(true);
    await servers.close();
    await expect.poll(() => alive(pid)).toBe(false);
    expect((await failureOf(servers.call("fixture", "env", {}))).failure).toBe(
      "unavailable",
    );
  });

  it("says why it could not start, and does not try again straight away", async () => {
    const servers = serversOf([stdio({ FIXTURE_FAIL_START: "no licence" })]);
    const first = await failureOf(servers.tools("fixture"));
    expect(first.failure).toBe("start_failed");
    expect(first.message).toContain("no licence");
    expect(await failureOf(servers.tools("fixture"))).toBe(first);
  });

  it("gives a command that is not there as a start failure", async () => {
    const servers = serversOf([
      { name: "gone", command: "/nonexistent/server" },
    ]);
    const failure = await failureOf(servers.tools("gone"));
    expect(failure.failure).toBe("start_failed");
    expect(failure.message).toContain("gone");
  });

  it("gives a crash as a failure of that call, and starts again for the next", async () => {
    const servers = serversOf([stdio({ FIXTURE_VALUE: "the-value" })]);
    const before = (await servers.call("fixture", "env", {})) as string;
    const failure = await failureOf(servers.call("fixture", "crash", {}));
    expect(failure.failure).toBe("crashed");
    expect(failure.message).toContain("dying with");
    const after = (await servers.call("fixture", "env", {})) as string;
    expect(after).not.toBe(before);
  });

  it("gives a tool's own error as a rejection", async () => {
    const servers = serversOf([stdio()]);
    const failure = await failureOf(servers.call("fixture", "fail", {}));
    expect(failure.failure).toBe("tool_error");
    expect(failure.message).toBe("fixture.fail: it did not work");
  });

  it("names the tools it has when asked for one it does not", async () => {
    const servers = serversOf([stdio()]);
    const failure = await failureOf(servers.call("fixture", "nope", {}));
    expect(failure.failure).toBe("unavailable");
    expect(failure.message).toContain("structured");
  });

  it("stops waiting for a call that takes too long", async () => {
    const servers = serversOf([stdio()], { callTimeoutMs: 50 });
    expect((await failureOf(servers.call("fixture", "hang", {}))).failure).toBe(
      "timeout",
    );
  });

  it("stops waiting when the caller gives up", async () => {
    const servers = serversOf([stdio()]);
    const abort = new AbortController();
    const call = servers.call("fixture", "hang", {}, { signal: abort.signal });
    await servers.tools("fixture");
    abort.abort(new Error("cancelled"));
    await expect(call).rejects.toThrow("cancelled");
  });

  it("gives a structured result as it is", async () => {
    const servers = serversOf([stdio()]);
    expect(await servers.call("fixture", "structured", {})).toEqual({
      count: 2,
    });
  });

  it("writes what is binary to a file and names it", async () => {
    const outputDir = dir();
    const servers = serversOf([stdio()], { outputDir });
    const answer = (await servers.call("fixture", "image", {})) as string;
    const path = /image\/png: (.+)\]/.exec(answer)?.[1];
    expect(answer).toContain("a dot");
    expect(answer).not.toContain("iVBOR");
    expect(readFileSync(path!).subarray(0, 4).toString("latin1")).toBe(
      "\x89PNG",
    );
  });

  it("puts what a server says through clean", async () => {
    const clean = <T>(value: T): T =>
      JSON.parse(JSON.stringify(value).replaceAll("hunter2", "[secret]")) as T;
    const servers = serversOf([stdio({ FIXTURE_VALUE: "hunter2" })], { clean });
    expect(await servers.call("fixture", "secret_echo", {})).toBe(
      "the key is [secret]",
    );
    const failure = await failureOf(servers.call("fixture", "crash", {}));
    expect(failure.message).toContain("[secret]");
    expect(failure.message).not.toContain("hunter2");
  });
});

describe("the list of tools", () => {
  it("outlives the session, so the next one knows it without starting anything", async () => {
    const cacheDir = dir();
    const first = serversOf([stdio()], { cacheDir });
    await first.tools("fixture");
    await first.close();
    const next = serversOf([stdio({ FIXTURE_FAIL_START: "must not start" })], {
      cacheDir,
    });
    expect(next.known("fixture")?.map((tool) => tool.name)).toContain("env");
  });

  it("is kept under the key it was given", async () => {
    const cacheDir = dir();
    const first = serversOf([stdio()], { cacheDir, cacheKey: () => "v1" });
    await first.tools("fixture");
    const next = serversOf([stdio()], { cacheDir, cacheKey: () => "v2" });
    expect(next.known("fixture")).toBeUndefined();
  });
});

describe("a remote server", () => {
  it("gets the configured headers and answers", async () => {
    const { url, seen } = await remote("Bearer good");
    const servers = serversOf([
      {
        name: "remote",
        type: "http",
        url,
        headers: { Authorization: "Bearer good" },
      },
    ]);
    expect(await servers.call("remote", "ping", {})).toBe("pong ping");
    expect(seen.every((one) => one.authorization === "Bearer good")).toBe(true);
  });

  it("is reported as needing a sign-in when it refuses a client with no credentials", async () => {
    const { url } = await remote("Bearer good");
    const servers = serversOf([{ name: "remote", type: "http", url }]);
    const failure = await failureOf(servers.tools("remote"));
    expect(failure.failure).toBe("needs_oauth");
    expect(failure.message).toContain("OAuth");
    expect(await needsOAuth({ name: "remote", type: "http", url })).toBe(true);
  });

  it("is not reported as OAuth when it refuses what was configured", async () => {
    const { url } = await remote("Bearer good");
    const servers = serversOf([
      {
        name: "remote",
        type: "http",
        url,
        headers: { Authorization: "Bearer bad" },
      },
    ]);
    const failure = await failureOf(servers.tools("remote"));
    expect(failure.failure).toBe("start_failed");
    expect(failure.message).toContain("credentials");
  });

  it("does not hold the close up when it will not answer the goodbye", async () => {
    let hang = false;
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += String(chunk)));
      request.on("end", () => {
        if (request.method === "DELETE") {
          hang = true;
          return;
        }
        if (request.method !== "POST") {
          response.writeHead(405);
          response.end();
          return;
        }
        const { id, method, params } = JSON.parse(body) as {
          id?: number;
          method: string;
          params: { protocolVersion?: string };
        };
        if (id === undefined) {
          response.writeHead(202);
          response.end();
          return;
        }
        response.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "session-1",
        });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result:
              method === "initialize"
                ? {
                    protocolVersion: params.protocolVersion,
                    capabilities: { tools: {} },
                    serverInfo: { name: "remote", version: "1.0.0" },
                  }
                : { tools: [] },
          }),
        );
      });
    });
    http.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    const servers = serversOf([
      { name: "remote", type: "http", url: `http://127.0.0.1:${port}/mcp` },
    ]);
    await servers.tools("remote");
    const started = Date.now();
    await servers.close();
    expect(hang).toBe(true);
    expect(Date.now() - started).toBeLessThan(4000);
    server.closeAllConnections();
  });

  it("does not count as needing a sign-in when it is open, or not there", async () => {
    const { url } = await remote();
    expect(await needsOAuth({ name: "remote", type: "http", url })).toBe(false);
    expect(
      await needsOAuth({
        name: "gone",
        type: "http",
        url: "http://127.0.0.1:9/mcp",
      }),
    ).toBe(false);
  });
});

it("asks for a server that is not in the session by saying which are", async () => {
  const servers = serversOf([stdio()]);
  const failure = await failureOf(servers.tools("other"));
  expect(failure.failure).toBe("unavailable");
  expect(failure.message).toContain("fixture");
});
