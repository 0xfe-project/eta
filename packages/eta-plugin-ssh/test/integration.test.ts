/**
 * A remote session in a real server (S32).
 *
 * The claim this slice has to earn: **a session on another machine runs the same tools and reads
 * the same kind of memory, against that machine's filesystem.** So the test builds a server whose
 * `envFor` asks the plugin, binds a session to a target, and then makes the session's *own tools*
 * do the work — a `bash` call and a `read` call through the session's tool registry, not through
 * the environment directly. If the wiring were wrong, those tools would touch this machine.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import type { SessionEnvironments } from "@eta/plugin-sdk";
import { type AssembledServer, assembleServer } from "@eta/server";
import { LocalTransport } from "@eta/ssh";
import { afterEach, describe, expect, it } from "vitest";
import { sshPlugin } from "../src/index";

const roots: string[] = [];
const servers: AssembledServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function until(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eta-ssh-server-"));
  roots.push(root);
  return root;
}

/** A "remote" machine: a directory of its own, and a home the plugin is told about. */
async function remote(): Promise<{ home: string; project: string }> {
  const home = await scratch();
  const project = join(home, "project");
  await mkdir(project, { recursive: true });
  return { home, project };
}

describe("a session bound to a remote target", () => {
  it("runs its file and shell tools on the other machine, and reads its memory there", async () => {
    const machine = await remote();
    // The far side's memory, in the far side's project.
    await mkdir(join(machine.project, ".eta"), { recursive: true });
    await writeFile(
      join(machine.project, ".eta", "MEMORY.md"),
      "## lesson\n- [remote#1] this machine's memory is the one that matters\n",
      "utf8",
    );
    // A file only the far side has: if the session reads it, it read the remote filesystem.
    await writeFile(
      join(machine.project, "remote-only.txt"),
      "on the other machine\n",
      "utf8",
    );

    const dataDir = await scratch();
    const plugin = sshPlugin({
      path: join(dataDir, "ssh.json"),
      transportFor: async () => new LocalTransport({ home: machine.home }),
    });
    const server = await assembleServer({
      dataDir,
      configPath: join(dataDir, "no-such-config.json"),
      models: fakeModels([
        assistantMessage({ content: [{ type: "text", text: "ok" }] }),
      ]) as never,
      pluginWatchIntervalMs: 0,
      // The plugin is mounted by hand here: it is a distributed plugin, and this test is about
      // the wiring a host does, not about the scanner (which has its own tests).
      plugins: [],
    });
    servers.push(server);
    // The plugin joins the same context the server built, so it registers on the same wire —
    // on a microtask, which is what the wait is for.
    server.ctx.plugin(plugin as never, undefined as never);
    await until(() =>
      server.wire
        .descriptors()
        .some((descriptor) => descriptor.name === "ssh.save"),
    );

    // Bind the target and one session, then ask the plugin for that session's environment the
    // way the manager does.
    await server.wire.dispatch(
      {
        op: "call",
        target: "ssh",
        action: "save",
        args: {
          target: { id: "box", host: "box.example", cwd: machine.project },
        },
      },
      { reply: () => undefined } as never,
    );
    plugin.bind("session-remote", "box");
    const environments: SessionEnvironments = plugin.environments;
    const environment = await environments.for("session-remote");
    expect(environment).toBeDefined();

    // The session itself, opened with that environment: its tools are the harness's, and they
    // act on the far side.
    const sessions = new (await import("@eta/server")).SessionManager({
      store: new (await import("@eta/server")).MemorySessionStore(),
      modelsFor: () =>
        fakeModels([
          assistantMessage({ content: [{ type: "text", text: "ok" }] }),
        ]) as never,
      envFor: () => environment,
      memoryFor: () => ({ home: machine.home }),
      platformFor: (meta) => ({
        cwd: meta.cwd,
        home: machine.home,
        configPath: join(dataDir, "config.json"),
        memoryTarget: join(machine.project, ".eta", "MEMORY.md"),
        memoryExists: true,
      }),
    });
    const created = await sessions.create({ cwd: machine.project });

    // A `bash` call through the session's own tool registry: it must run on the far side, where
    // the project is.
    const bash = await created.session.kernel.tools.execute(
      "bash",
      { command: "cat remote-only.txt" },
      {
        turn: 1,
        toolCallId: "c1",
      } as never,
    );
    expect(JSON.stringify(bash)).toContain("on the other machine");

    // And `read`, the same way.
    const read = await created.session.kernel.tools.execute(
      "read",
      { path: "remote-only.txt" },
      {
        turn: 1,
        toolCallId: "c2",
      } as never,
    );
    expect(JSON.stringify(read)).toContain("on the other machine");

    // The memory block comes from the far side's project, and the platform briefing names the
    // far side's paths — the words are the harness's, the paths are that machine's.
    const prompt = await created.session.promptSections();
    expect(
      prompt.sections.find((section) => section.name === "memory")?.text,
    ).toContain("this machine's memory");
    expect(
      prompt.sections.find((section) => section.name === "platform")?.text,
    ).toContain(machine.home);

    // The local machine has none of it: the files were never here.
    expect(
      await Bun.file(join(process.cwd(), "remote-only.txt")).exists(),
    ).toBe(false);
    await sessions.closeAll();
  });
});
