import type { Host } from "../src/host";
/**
 * Agents (REFACTOR.md §9, P0.8).
 *
 * Two things are being tested here. The first is the register itself: create, read, change,
 * delete, over HTTP. The second is the line this step exists to draw — **an agent is not a
 * session** — and the way to test a line like that is to make something that would cross it:
 * creating an agent must not open a conversation, and deleting one must not close any.
 *
 * The model check runs against a real model layer built from a config file (no network: building
 * a provider is configuration work), which is the only way to test "this host cannot reach that
 * model" — a scripted fake answers yes to everything, which would make the check look green
 * while doing nothing.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleHost } from "../src/host";

const roots: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const CONFIG = {
  providers: [
    {
      id: "local",
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:1/v1",
      models: [{ id: "m1" }, { id: "m2" }],
    },
  ],
  defaultModel: "local:m1",
};

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eta-agents-"));
  roots.push(root);
  await writeFile(join(root, "config.json"), JSON.stringify(CONFIG), "utf8");
  return root;
}

async function start(): Promise<Host> {
  const host = await assembleHost({
    dataDir: await scratch(),
    port: 0,
    warn: () => undefined,
  });
  hosts.push(host);
  return host;
}

const url = (host: Host, path: string): string =>
  `http://127.0.0.1:${host.port}${path}`;

const send = (
  host: Host,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> =>
  fetch(url(host, path), {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });

interface Agent {
  id: string;
  name: string;
  model?: string;
  instructions: string;
  plugins: string[];
  createdAt: string;
  updatedAt: string;
}

const agentOf = async (response: Response): Promise<Agent> =>
  ((await response.json()) as { agent: Agent }).agent;

describe("the register", () => {
  it("creates, lists, reads, changes and deletes", async () => {
    const host = await start();

    const created = await send(host, "POST", "/agents", {
      name: "reviewer",
      model: "local:m2",
      instructions: "Review diffs, do not push.",
      plugins: ["git"],
    });
    expect(created.status).toBe(201);
    const agent = await agentOf(created);
    expect(agent).toMatchObject({
      name: "reviewer",
      model: "local:m2",
      instructions: "Review diffs, do not push.",
      plugins: ["git"],
    });

    const listed = (await (await send(host, "GET", "/agents")).json()) as {
      agents: Agent[];
    };
    expect(listed.agents.map((row) => row.name)).toEqual(["reviewer"]);

    const read = await agentOf(await send(host, "GET", `/agents/${agent.id}`));
    expect(read.instructions).toBe("Review diffs, do not push.");

    const patched = await agentOf(
      await send(host, "PATCH", `/agents/${agent.id}`, {
        instructions: "Review only.",
      }),
    );
    expect(patched.instructions).toBe("Review only.");
    // Untouched fields stay: a patch is a patch, not a replace.
    expect(patched.name).toBe("reviewer");
    expect(patched.plugins).toEqual(["git"]);

    expect((await send(host, "DELETE", `/agents/${agent.id}`)).status).toBe(
      204,
    );
    expect((await send(host, "GET", `/agents/${agent.id}`)).status).toBe(404);
    expect((await send(host, "DELETE", `/agents/${agent.id}`)).status).toBe(
      404,
    );
  });

  it("refuses a name-less agent, and says so in the one error shape", async () => {
    const host = await start();
    const response = await send(host, "POST", "/agents", { model: "local:m1" });
    expect(response.status).toBe(400);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe("NO_NAME");
  });
});

describe("the model an agent names", () => {
  it("must be one this host can reach", async () => {
    const host = await start();

    const unknown = await send(host, "POST", "/agents", {
      name: "writer",
      model: "local:nope",
    });
    expect(unknown.status).toBe(409);
    expect(
      ((await unknown.json()) as { error: { code: string } }).error.code,
    ).toBe("MODEL_UNKNOWN");

    // A bare id reads as the default provider, which this host does not serve — an answer, not
    // a guess about which provider was meant.
    const bare = await send(host, "POST", "/agents", {
      name: "writer",
      model: "m1",
    });
    expect(bare.status).toBe(409);

    const ok = await send(host, "POST", "/agents", {
      name: "writer",
      model: "local:m1",
    });
    expect(ok.status).toBe(201);

    // And the same check holds on a change, not only on creation.
    const id = (await agentOf(ok)).id;
    expect(
      (await send(host, "PATCH", `/agents/${id}`, { model: "local:nope" }))
        .status,
    ).toBe(409);
  });

  it("may be left out entirely: an agent with no model is a configuration, not an error", async () => {
    const host = await start();
    const created = await send(host, "POST", "/agents", { name: "unset" });
    expect(created.status).toBe(201);
    expect((await agentOf(created)).model).toBeUndefined();
  });
});

describe("an agent is not a session", () => {
  it("creating or deleting an agent does not open or close a conversation", async () => {
    const host = await start();

    // Nothing is running, and the sessions list is empty to begin with.
    const before = (await (await send(host, "GET", "/sessions")).json()) as {
      sessions: unknown[];
    };
    expect(before.sessions).toEqual([]);

    const agent = await agentOf(
      await send(host, "POST", "/agents", { name: "talker" }),
    );
    const afterCreate = (await (
      await send(host, "GET", "/sessions")
    ).json()) as {
      sessions: unknown[];
    };
    expect(afterCreate.sessions).toEqual([]);

    // A session is its own thing: it has a working directory and a journal, and no agent id —
    // the row that ties the two together is the group's thread, which is P2's table.
    const session = (await (
      await send(host, "POST", "/sessions", { title: "unrelated" })
    ).json()) as { meta: Record<string, unknown> };
    expect(session.meta.agentId).toBeUndefined();
    expect(session.meta.cwd).toBeTruthy();

    await send(host, "DELETE", `/agents/${agent.id}`);
    const afterDelete = (await (
      await send(host, "GET", "/sessions")
    ).json()) as {
      sessions: unknown[];
    };
    expect(afterDelete.sessions).toHaveLength(1);
  });
});
