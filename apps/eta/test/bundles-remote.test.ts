/**
 * Bundles on a daemon: the primary sends the bundle's files over the link, once, and the values
 * with the session; the daemon starts the MCP servers and runs the rules on its own machine.
 */
import { existsSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
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
import { remoteWorld } from "./support/remote";

describe("an agent that loads a bundle, on a daemon", () => {
  // TOBEREFR: see packages/TOBEREFR/TODO.md
  it.skip("gets the skills, the MCP tools and the rules there, and the secret only in their processes", async () => {
    const home = await tempDir("eta-home-");
    await writeBundle(home, "demo", demoFiles());
    const { models, requests } = scriptedModels((request) => {
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
    const r = await remoteWorld({ dataDir: home, models });
    r.client.subscribe("bundles");
    await until(() =>
      listed(r.client).some((bundle) => bundle.name === "demo"),
    );
    await r.client.call("bundles", "configure", {
      name: "demo",
      values: { DEMO_TOKEN: SECRET },
    });
    const agent = await r.agent("Ada", { bundles: ["demo"] });
    await r.client.call("projects", "setSteward", {
      projectId: r.remoteProject.id,
      agentId: agent.id,
    });
    const group = await r.group(r.remoteProject.id, [agent.id]);
    await r.watch(group.id);

    const sent = await r.send(group.id, "go");
    const done = await r.settled(group.id, sent.replies[0]!.id);
    expect(done.status).toBe("done");
    expect(done.text).toBe("finished");

    const first = requests[0]!;
    // The skills are the copy the daemon keeps, not the primary's directory.
    expect(first.system).toContain("demo-skill");
    expect(first.system).toContain(join(r.daemon.dataDir, "bundles"));
    expect(first.system).not.toContain(join(home, ".eta"));
    expect(first.tools).toEqual(expect.arrayContaining(["mcp"]));
    // The prompt_submit rule runs on the primary, with the same values.
    expect(first.transcript.join("\n")).toContain(
      `hook-token-len:${SECRET.length}`,
    );

    const seen = requests.at(-1)!.transcript.join("\n");
    expect(seen).toContain(digestOf(SECRET));
    expect(seen).toContain("shell:[]");
    expect(seen).toContain("demo/no-forbidden");
    expect(existsSync(join(r.dir, "forbidden"))).toBe(false);
    expect(seen).not.toContain(SECRET);

    // The values went over the link with the session and nowhere else: not to the browser, and
    // not onto either machine's disk.
    const carrying = [...r.traffic.in, ...r.traffic.out].filter((text) =>
      text.includes(SECRET),
    );
    expect(carrying.length).toBeGreaterThan(0);
    for (const text of carrying) expect(text).toContain('"open"');
    expect(JSON.stringify(r.client.frames)).not.toContain(SECRET);
    expect(await filesContaining(r.daemon.dataDir, SECRET)).toEqual([]);
    expect(await filesContaining(home, SECRET)).toEqual([]);
  });

  it("sends the files once, and again when they change", async () => {
    const home = await tempDir("eta-home-");
    await writeBundle(home, "demo", demoFiles());
    const { models } = scriptedModels(() => say("ok"));
    const r = await remoteWorld({ dataDir: home, models });
    const { group } = await r.agents("Ada");
    const agentId = (r.client.section<{ agentId: string }[]>(
      `conversations.${group.id}`,
      "members",
    ) ?? [])[0]!.agentId;
    await r.client.call("agents", "update", { agentId, bundles: ["demo"] });
    const puts = () =>
      r.traffic.in.filter((text) => text.includes('"action":"bundlePut"'))
        .length;

    const one = await r.send(group.id, "one");
    await r.settled(group.id, one.replies[0]!.id);
    expect(puts()).toBe(1);
    const two = await r.send(group.id, "two");
    await r.settled(group.id, two.replies[0]!.id);
    expect(puts()).toBe(1);

    await writeBundle(home, "demo", {
      "skills/demo-skill/references/setup.md": "Changed.\n",
    });
    const three = await r.send(group.id, "three");
    await r.settled(group.id, three.replies[0]!.id);
    expect(puts()).toBe(2);
  });

  it("has only the skills there until the bundle is configured", async () => {
    const home = await tempDir("eta-home-");
    await writeBundle(home, "demo", demoFiles());
    const { models, requests } = scriptedModels(() => say("ok"));
    const r = await remoteWorld({ dataDir: home, models });
    const { group } = await r.agents("Ada");
    const members = r.client.section<{ agentId: string }[]>(
      `conversations.${group.id}`,
      "members",
    )!;
    await r.client.call("agents", "update", {
      agentId: members[0]!.agentId,
      bundles: ["demo"],
    });
    const sent = await r.send(group.id, "hi");
    await r.settled(group.id, sent.replies[0]!.id);
    expect(requests[0]!.system).toContain("demo-skill");
    expect(requests[0]!.tools).not.toContain("mcp");
  });
});

describe("what a bundle requires, per machine", () => {
  it.skipIf(process.platform === "win32")(
    "asks each machine for itself",
    async () => {
      const home = await tempDir("eta-home-");
      await writeBundle(
        home,
        "demo",
        demoFiles({ requires: ["eta-test-only-here"] }),
      );
      const r = await remoteWorld({ dataDir: home });
      r.client.subscribe("bundles");
      await until(() =>
        listed(r.client).some((bundle) => bundle.name === "demo"),
      );
      const machines = () =>
        listed(r.client).find((bundle) => bundle.name === "demo")!.machines;
      await until(() => machines().length === 2);
      expect(machines().every((machine) => !machine.ready)).toBe(true);

      // The command appears on the PATH, and the daemon is asked: it has it.
      const bin = await tempDir("eta-bin-");
      const command = join(bin, "eta-test-only-here");
      await writeFile(command, "#!/bin/sh\n");
      await chmod(command, 0o755);
      const path = process.env.PATH;
      process.env.PATH = `${bin}:${path}`;
      try {
        await r.client.call("bundles", "recheck", {});
      } finally {
        process.env.PATH = path;
      }
      // The primary is looked at whenever the page is made, and no longer has it; the daemon
      // answered while it was there, and its answer stands until it is asked again. (Any change
      // makes the page again.)
      await r.client.call("bundles", "configure", {
        name: "demo",
        values: { DEMO_REGION: "eu" },
      });
      await until(
        () =>
          machines().some((machine) => machine.ready) &&
          machines().some((machine) => !machine.ready),
      );
      const byName = Object.fromEntries(
        machines().map((machine) => [
          machine.machineId === r.daemon.machineId ? "daemon" : "primary",
          machine,
        ]),
      );
      expect(byName.daemon).toMatchObject({
        ready: true,
        missing: [],
        checked: true,
      });
      expect(byName.primary).toMatchObject({
        ready: false,
        missing: ["eta-test-only-here"],
      });
    },
  );
});
