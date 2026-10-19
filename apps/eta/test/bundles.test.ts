/* eslint-disable no-template-curly-in-string -- bundle variables */
/**
 * Bundles on the host: what is listed and where from, how an agent that loads one is equipped
 * (skills, MCP tools, hook rules), and where its secret goes and does not go.
 */
import type { AgentView, BundleView } from "@eta/client-contracts";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  demoFiles,
  digestOf,
  filesContaining,
  listed,
  SECRET,
  writeBundle,
} from "./support/bundles";
import { until } from "./support/client";
import { tempDir } from "./support/host";
import { call, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

const view = (w: Awaited<ReturnType<typeof world>>, name: string) =>
  listed(w.client).find((bundle) => bundle.name === name);

async function started(files: Record<string, string> | null = demoFiles()) {
  const home = await tempDir("eta-home-");
  if (files !== null) await writeBundle(home, "demo", files);
  return home;
}

describe("the bundles that are listed", () => {
  it("lists the built-in ones, from the repository", async () => {
    const w = await world({ dataDir: await started(null) });
    w.client.subscribe("bundles");
    await until(() => listed(w.client).length > 0);
    const names = listed(w.client).map((bundle) => bundle.name);
    expect(names).toEqual(
      expect.arrayContaining(["agenvo", "github", "grok", "oomol"]),
    );
    const github = view(w, "github")!;
    expect(github.source).toEqual({ kind: "builtin" });
    // Only a skill: the login is the GitHub App's (settings → 连接), the tools are the host's.
    expect(github.requires).toEqual(["git", "gh"]);
    expect(github.skills).toEqual(["github"]);
    expect(github.mcpServers).toEqual([]);
    expect(github.fields).toEqual([]);
    expect(github.configured).toBe(true);
    // It has a service, which waits for its secret.
    expect(view(w, "agenvo")!.service).toEqual({
      state: "stopped",
      message: null,
    });
    expect(listed(w.client).every((bundle) => bundle.problem === null)).toBe(
      true,
    );
  });

  it("picks up the user's own directory as it changes, and reports one that does not parse", async () => {
    const home = await started(null);
    const w = await world({ dataDir: home });
    w.client.subscribe("bundles");
    await until(() => listed(w.client).length > 0);
    expect(view(w, "demo")).toBeUndefined();

    await writeBundle(home, "demo", demoFiles());
    await until(() => view(w, "demo") !== undefined);
    expect(view(w, "demo")).toMatchObject({
      source: { kind: "local" },
      description: "Demo",
      skills: ["demo-skill"],
      mcpServers: ["fake"],
      hooks: true,
    });

    // Edited in place: the page follows without a restart.
    await writeBundle(home, "demo", {
      "plugin.json": JSON.stringify({ name: "demo", description: "Changed" }),
    });
    await until(() => view(w, "demo")?.description === "Changed");

    await writeBundle(home, "broken", { "plugin.json": "{ not json" });
    await until(() => view(w, "broken") !== undefined);
    expect(view(w, "broken")!.problem).toMatch(/plugin\.json/);
    expect(view(w, "demo")!.problem).toBeNull();
  });

  it("lets the user's directory replace a built-in bundle of the same name", async () => {
    const home = await started(null);
    await writeBundle(home, "grok", {
      "plugin.json": JSON.stringify({ name: "grok", description: "Mine" }),
    });
    const w = await world({ dataDir: home });
    w.client.subscribe("bundles");
    await until(() => view(w, "grok") !== undefined);
    expect(view(w, "grok")).toMatchObject({
      description: "Mine",
      source: { kind: "local" },
    });
  });

  it("refuses a directory whose manifest names another bundle", async () => {
    const home = await started(null);
    await writeBundle(home, "one", {
      "plugin.json": JSON.stringify({ name: "two" }),
    });
    const w = await world({ dataDir: home });
    w.client.subscribe("bundles");
    await until(() => view(w, "one") !== undefined);
    expect(view(w, "one")!.problem).toMatch(/two/);
    expect(view(w, "two")).toBeUndefined();
  });
});

describe("configuring a bundle", () => {
  it("stores values sealed, reports whether they are set, and never reads a secret back", async () => {
    const home = await started();
    const w = await world({ dataDir: home });
    w.client.subscribe("bundles");
    await until(() => view(w, "demo") !== undefined);
    expect(view(w, "demo")!.configured).toBe(false);

    await w.client.call("bundles", "configure", {
      name: "demo",
      values: { DEMO_TOKEN: SECRET, DEMO_REGION: "eu" },
    });
    await until(() => view(w, "demo")!.configured);
    const fields = view(w, "demo")!.fields;
    expect(fields.find((f) => f.name === "DEMO_TOKEN")).toMatchObject({
      secret: true,
      set: true,
      value: null,
    });
    expect(fields.find((f) => f.name === "DEMO_REGION")).toMatchObject({
      secret: false,
      set: true,
      value: "eu",
    });
    // Nothing the browser was ever sent holds it, and neither does any file the host wrote.
    expect(JSON.stringify(w.client.frames)).not.toContain(SECRET);
    expect(await filesContaining(home, SECRET)).toEqual([]);
    const db = w.host.db
      .query<{ sealed: Uint8Array }, []>("SELECT sealed FROM bundle_config")
      .get()!;
    expect(Buffer.from(db.sealed).includes(SECRET)).toBe(false);

    // A value is cleared with null, and one that is not named stays.
    await w.client.call("bundles", "configure", {
      name: "demo",
      values: { DEMO_REGION: null },
    });
    await until(
      () => !view(w, "demo")!.fields.find((f) => f.name === "DEMO_REGION")!.set,
    );
    expect(view(w, "demo")!.configured).toBe(true);
  });

  it("refuses what the bundle does not ask for, without echoing the value", async () => {
    const w = await world({ dataDir: await started() });
    w.client.subscribe("bundles");
    await until(() => view(w, "demo") !== undefined);
    await expect(
      w.client.call("bundles", "configure", {
        name: "demo",
        values: { NOT_A_FIELD: SECRET },
      }),
    ).rejects.toThrow(/NOT_A_FIELD/);
    await expect(
      w.client.call("bundles", "configure", {
        name: "demo",
        values: { DEMO_TOKEN: SECRET.repeat(10) },
      }),
    ).rejects.toThrow(/DEMO_TOKEN/);
    for (const frame of w.client.frames)
      expect(JSON.stringify(frame)).not.toContain(SECRET);
    await expect(
      w.client.call("bundles", "configure", { name: "nope", values: {} }),
    ).rejects.toThrow(/no bundle/);
  });

  it("keeps the values across a restart, and reads them as nothing under another key", async () => {
    const home = await started();
    const first = await world({ dataDir: home });
    await first.client.call("bundles", "configure", {
      name: "demo",
      values: { DEMO_TOKEN: SECRET },
    });
    await first.host.close();
    const second = await world({ dataDir: home });
    second.client.subscribe("bundles");
    await until(() => view(second, "demo") !== undefined);
    expect(view(second, "demo")!.configured).toBe(true);
    await second.host.close();

    await writeFile(join(home, "secret.key"), Buffer.alloc(32, 7));
    const third = await world({ dataDir: home });
    third.client.subscribe("bundles");
    await until(() => view(third, "demo") !== undefined);
    expect(view(third, "demo")!.configured).toBe(false);
  });
});

describe("an agent that loads a bundle", () => {
  const ask = () =>
    scriptedModels((request) => {
      const results = request.transcript.filter((line) =>
        line.startsWith("toolResult"),
      ).length;
      if (results === 0)
        return call("mcp", {
          tool: "env",
          server: "fake",
          args: { name: "DEMO_TOKEN" },
        });
      if (results === 1)
        return call("bash", { command: 'echo "shell:[$DEMO_TOKEN]"' });
      if (results === 2) return call("bash", { command: "touch forbidden" });
      return say("finished");
    });

  async function setUp(home: string, models: ReturnType<typeof ask>["models"]) {
    const w = await world({ dataDir: home, models });
    w.client.subscribe("bundles");
    await until(() => view(w, "demo") !== undefined);
    const agent = await w.agent("Ada", { bundles: ["demo"] });
    const dir = await tempDir("eta-project-");
    const project = await w.project({ path: dir, stewardId: agent.id });
    const group = await w.group(project.id, [agent.id]);
    await w.watch(group.id);
    return { w, agent, dir, group };
  }

  it("keeps the bundles an agent names", async () => {
    const { models } = ask();
    const w = await world({ dataDir: await started(), models });
    const agent = await w.agent("Ada", { bundles: ["demo", "github"] });
    expect(agent.bundles).toEqual(["demo", "github"]);
    const { agent: edited } = (await w.client.call("agents", "update", {
      agentId: agent.id,
      bundles: ["github"],
    })) as { agent: AgentView };
    expect(edited.bundles).toEqual(["github"]);
    await expect(
      w.client.call("agents", "update", {
        agentId: agent.id,
        bundles: ["Bad Name"],
      }),
    ).rejects.toThrow(/bundle/);
  });

  it("gets the skills, the MCP tools and the rules, and the secret only in their processes", async () => {
    const home = await started();
    const { models, requests } = ask();
    const { w, dir, group } = await setUp(home, models);
    await w.client.call("bundles", "configure", {
      name: "demo",
      values: { DEMO_TOKEN: SECRET },
    });

    const sent = await w.send(group.id, "go");
    const done = await w.settled(group.id, sent.replies[0]!.id);
    expect(done.status).toBe("done");
    expect(done.text).toBe("finished");

    const first = requests[0]!;
    // Skills: the catalog names the skill and where its file is.
    expect(first.system).toContain("demo-skill");
    expect(first.system).toContain(
      join(home, ".eta", "bundles", "demo", "skills"),
    );
    // MCP tools, from a server started for this session.
    expect(first.tools).toEqual(expect.arrayContaining(["mcp"]));
    // The hook rule that adds a line to the prompt ran with the secret in its environment.
    expect(first.transcript.join("\n")).toContain(
      `hook-token-len:${SECRET.length}`,
    );
    const seen = requests.at(-1)!.transcript.join("\n");
    // The MCP server's process has the secret...
    expect(seen).toContain(digestOf(SECRET));
    // ...the agent's shell does not...
    expect(seen).toContain("shell:[]");
    // ...and the bundle's rule stopped the command, under the bundle's name.
    expect(seen).toContain("demo/no-forbidden");
    expect(seen).toContain("the demo bundle forbids this");
    expect(existsSync(join(dir, "forbidden"))).toBe(false);

    // Nothing was written down: not in the transcript, not in a file, not on the wire.
    expect(seen).not.toContain(SECRET);
    expect(await filesContaining(home, SECRET)).toEqual([]);
    expect(JSON.stringify(w.client.frames)).not.toContain(SECRET);
  });

  it("has only the skills until the bundle is configured, then the rest from the next message", async () => {
    const { models, requests } = scriptedModels(() => say("ok"));
    const home = await started();
    const w = await world({ dataDir: home, models });
    w.client.subscribe("bundles");
    await until(() => view(w, "demo") !== undefined);
    const agent = await w.agent("Ada", { bundles: ["demo"] });
    const project = await w.project({ stewardId: agent.id });
    const group = await w.group(project.id, [agent.id]);
    await w.watch(group.id);

    const one = await w.send(group.id, "hello");
    await w.settled(group.id, one.replies[0]!.id);
    expect(requests[0]!.system).toContain("demo-skill");
    expect(requests[0]!.tools).not.toContain("mcp");
    // No token, no hook line either.
    expect(requests[0]!.transcript.join("\n")).not.toContain("hook-token-len");

    await w.client.call("bundles", "configure", {
      name: "demo",
      values: { DEMO_TOKEN: SECRET },
    });
    const two = await w.send(group.id, "again");
    await w.settled(group.id, two.replies[0]!.id);
    expect(requests.at(-1)!.tools).toContain("mcp");
  });

  it("follows an edit of the bundle's files at the next message", async () => {
    const { models, requests } = scriptedModels(() => say("ok"));
    const home = await started();
    const w = await world({ dataDir: home, models });
    w.client.subscribe("bundles");
    await until(() => view(w, "demo") !== undefined);
    const agent = await w.agent("Ada", { bundles: ["demo"] });
    const project = await w.project({ stewardId: agent.id });
    const group = await w.group(project.id, [agent.id]);
    await w.watch(group.id);
    const one = await w.send(group.id, "hello");
    await w.settled(group.id, one.replies[0]!.id);
    expect(requests.at(-1)!.system).not.toContain("second-skill");

    await mkdir(
      join(home, ".eta", "bundles", "demo", "skills", "second-skill"),
      {
        recursive: true,
      },
    );
    await writeFile(
      join(
        home,
        ".eta",
        "bundles",
        "demo",
        "skills",
        "second-skill",
        "SKILL.md",
      ),
      "---\nname: second-skill\ndescription: Added later.\n---\n# Second\n",
    );
    const two = await w.send(group.id, "again");
    await w.settled(group.id, two.replies[0]!.id);
    expect(requests.at(-1)!.system).toContain("second-skill");
  });

  it("does not get a bundle it does not load", async () => {
    const { models, requests } = scriptedModels(() => say("ok"));
    const home = await started();
    const w = await world({ dataDir: home, models });
    await w.client.call("bundles", "configure", {
      name: "demo",
      values: { DEMO_TOKEN: SECRET },
    });
    const agent = await w.agent("Bea");
    const project = await w.project({ stewardId: agent.id });
    const group = await w.group(project.id, [agent.id]);
    await w.watch(group.id);
    const sent = await w.send(group.id, "hi");
    await w.settled(group.id, sent.replies[0]!.id);
    expect(requests[0]!.system).not.toContain("demo-skill");
    expect(requests[0]!.tools).not.toContain("mcp");
  });
});

describe("what a bundle requires", () => {
  it("is judged on the machine itself, and says what is missing", async () => {
    const home = await started(
      demoFiles({ requires: ["node", "definitely-not-installed-xyz"] }),
    );
    const w = await world({ dataDir: home });
    w.client.subscribe("bundles");
    await until(() => view(w, "demo") !== undefined);
    const demo: BundleView = view(w, "demo")!;
    expect(demo.machines).toHaveLength(1);
    expect(demo.machines[0]).toMatchObject({
      ready: false,
      checked: true,
      missing: ["definitely-not-installed-xyz"],
    });
  });
});

describe("a bundle's service", () => {
  const SERVICE = `
const port = Number(process.env.PORT);
Bun.serve({
  hostname: process.env.HOST,
  port,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/die") process.exit(3);
    return Response.json({
      path: url.pathname,
      tokenLength: (process.env.SVC_TOKEN ?? "").length,
      data: process.env.ETA_BUNDLE_DATA,
      authorization: request.headers.get("authorization"),
      cookie: request.headers.get("cookie"),
    });
  },
});
`;
  const files = (extra: Record<string, string> = {}) => ({
    "plugin.json": JSON.stringify({
      name: "svc",
      description: "Service",
      config: {
        type: "object",
        required: ["SVC_TOKEN"],
        properties: {
          SVC_TOKEN: { type: "string", writeOnly: true, maxLength: 50 },
        },
      },
      service: { command: [process.execPath, "${PLUGIN_ROOT}/svc.ts"] },
    }),
    "svc.ts": SERVICE,
    ...extra,
  });
  const state = (w: Awaited<ReturnType<typeof world>>) =>
    view(w, "svc")?.service?.state;

  it("runs on loopback once configured, is proxied by the host, and gets the values", async () => {
    const home = await started(null);
    await writeBundle(home, "svc", files());
    const w = await world({ dataDir: home });
    w.client.subscribe("bundles");
    await until(() => view(w, "svc") !== undefined);
    // Nothing to run until it is configured.
    expect(state(w)).toBe("stopped");
    expect(
      (await fetch(`http://127.0.0.1:${w.host.port}/bundles/svc/service/x`))
        .status,
    ).toBe(404);

    await w.client.call("bundles", "configure", {
      name: "svc",
      values: { SVC_TOKEN: SECRET },
    });
    await until(() => state(w) === "ready", 20_000);
    const response = await fetch(
      `http://127.0.0.1:${w.host.port}/bundles/svc/service/hello?x=1`,
      {
        headers: {
          cookie: "eta_session=abc",
          authorization: "Bearer user-token",
        },
      },
    );
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      path: "/hello",
      tokenLength: SECRET.length,
      // The user's credentials are the host's.
      authorization: null,
      cookie: null,
    });
    expect(String(body.data)).toContain(join("bundles", "svc"));
    // A page of another origin cannot write to it with the user's cookie.
    const foreign = await fetch(
      `http://127.0.0.1:${w.host.port}/bundles/svc/service/hello`,
      { method: "POST", headers: { origin: "http://evil.example" }, body: "x" },
    );
    expect(foreign.status).toBe(403);
    expect(JSON.stringify(w.client.frames)).not.toContain(SECRET);
  });

  it("restarts when its values change, shows why it failed, and stops with the host", async () => {
    const home = await started(null);
    await writeBundle(home, "svc", files());
    const w = await world({ dataDir: home });
    w.client.subscribe("bundles");
    await until(() => view(w, "svc") !== undefined);
    await w.client.call("bundles", "configure", {
      name: "svc",
      values: { SVC_TOKEN: "abcd" },
    });
    await until(() => state(w) === "ready", 20_000);
    const url = `http://127.0.0.1:${w.host.port}/bundles/svc/service/`;
    expect(
      ((await (await fetch(url)).json()) as { tokenLength: number })
        .tokenLength,
    ).toBe(4);

    await w.client.call("bundles", "configure", {
      name: "svc",
      values: { SVC_TOKEN: "abcdefgh" },
    });
    await until(async () => {
      const response = await fetch(url).catch(() => undefined);
      if (response?.ok !== true) return false;
      return (
        ((await response.json()) as { tokenLength: number }).tokenLength === 8
      );
    }, 20_000);

    // It dies: the page says so, and it is not started again behind the user's back.
    await fetch(`${url}die`).catch(() => undefined);
    await until(() => state(w) === "error", 20_000);
    expect(view(w, "svc")!.service!.message).not.toBeNull();
    // Asking again (recheck) is what starts it.
    await w.client.call("bundles", "configure", {
      name: "svc",
      values: { SVC_TOKEN: "zzzzzz" },
    });
    await until(() => state(w) === "ready", 20_000);
  });
});
