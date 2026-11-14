/**
 * `/agent` against a real host: the agent goes out to a YAML file, the user's editor (a function
 * that rewrites the file) changes it, and what changed comes back through `agents.update`. Every
 * problem — broken YAML, an invalid field, the host refusing — opens a layer to edit again or
 * discard.
 */
import type { AgentView } from "@eta/client-contracts";
import type { ProcessLaunch } from "../../src/ui/editor";
import type { HostRendered } from "../ext-support/render-with-host";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDocument } from "yaml";
import agentExtension from "../../src/ext/agent";
import { renderWithHost } from "../ext-support/render-with-host";
import { baseUrl, testHost } from "../support/host";
import { tempDir } from "../support/temp";
import { KEYS } from "../ui-support/render";

const AGENT_FILE_PREFIX = "eta-agent-";
let filesBefore = new Set<string>();
const opened: HostRendered[] = [];

async function agentFilesNow(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((n) =>
    n.startsWith(AGENT_FILE_PREFIX),
  );
}

beforeEach(async () => {
  filesBefore = new Set(await agentFilesNow());
});

// An edit still open when a test ends goes when its shell does, and keeps a copy of what was
// written (the behaviour under test elsewhere). The files a test made are removed here.
afterEach(async () => {
  for (const r of opened.splice(0)) await r.close();
  const deadline = Date.now() + 5_000;
  let made = (await agentFilesNow()).filter((n) => !filesBefore.has(n));
  while (
    made.some((n) => !n.endsWith("-unsent.yaml")) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    made = (await agentFilesNow()).filter((n) => !filesBefore.has(n));
  }
  for (const name of made) await rm(join(tmpdir(), name), { force: true });
});

const KEY_ORDER = [
  "name",
  "persona",
  "runtime",
  "model",
  "thinkingLevel",
  "machineId",
  "plugins",
  "instructions",
];

/** What the stand-in editor does with the file; its return value is the editor's exit code. */
type EditStep = (file: string) => Promise<number | null> | number | null;

interface Session {
  r: HostRendered;
  agent: AgentView;
  /** The files the editor was opened on, in order. */
  files: string[];
  /** The file's text each time the editor opened, before the step changed it. */
  seen: string[];
  updates: () => unknown[];
  /** The wire's own `call`, for a test that puts its own implementation on the spy. */
  realCall: HostRendered["wire"]["call"];
}

/** A host with one configured provider, so the guide has models to list. */
async function dataDirWithProvider(): Promise<string> {
  const dataDir = join(await tempDir("eta-tui-agent-"), ".eta");
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    join(dataDir, "config.json"),
    `${JSON.stringify({
      providers: [
        {
          id: "a",
          kind: "openai-compatible",
          baseUrl: "https://a.example/v1",
          apiKey: "test-key",
          models: [{ id: "m1", name: "m1" }],
        },
      ],
    })}\n`,
  );
  return dataDir;
}

/**
 * The shell with `/agent` only, an agent made after it connected, and an editor that runs
 * `steps` one per opening (exit 0 without touching the file once they run out).
 */
async function start(
  steps: EditStep[],
  options: {
    locale?: "en" | "zh";
    create?: Record<string, unknown>;
    columns?: number;
  } = {},
): Promise<Session> {
  const files: string[] = [];
  const seen: string[] = [];
  const queue = [...steps];
  const r = await renderWithHost({
    extensions: [agentExtension],
    host: { dataDir: await dataDirWithProvider() },
    ...(options.columns === undefined ? {} : { columns: options.columns }),
    settings: { locale: options.locale ?? "en" },
    runProcess: async (launch: ProcessLaunch) => {
      const file = launch.args.at(-1) ?? "";
      files.push(file);
      seen.push(existsSync(file) ? await readFile(file, "utf8") : "");
      const step = queue.shift();
      return step === undefined ? 0 : step(file);
    },
  });
  const { agent } = await r.wire.call<{ agent: AgentView }>(
    "agents",
    "create",
    {
      name: "Ada",
      instructions: "Old line",
      model: "fake:fake-model",
      ...options.create,
    },
  );
  const realCall = r.wire.call.bind(r.wire);
  const call = vi.spyOn(r.wire, "call");
  const updates = () =>
    call.mock.calls
      .filter(([target, action]) => target === "agents" && action === "update")
      .map(([, , args]) => args);
  opened.push(r);
  return { r, agent, files, seen, updates, realCall };
}

/** The agent as the host has it now. */
async function onHost(
  r: HostRendered,
  id: string,
): Promise<AgentView | undefined> {
  const release = r.wire.subscribe("agents");
  try {
    await r.waitUntil(
      () => (r.wire.store.getState().targets.agents?.version ?? 0) > 0,
      "the agents' state",
    );
    await r.settle();
    const list = r.wire.store.getState().targets.agents?.sections.list as
      | AgentView[]
      | undefined;
    return list?.find((a) => a.id === id);
  } finally {
    release();
  }
}

/** Replaces the line of `key` (one-line values only) in the file. */
async function setLine(file: string, key: string, line: string): Promise<void> {
  const text = await readFile(file, "utf8");
  const pattern = new RegExp(`^${key}:.*$`, "m");
  expect(text).toMatch(pattern);
  await writeFile(file, text.replace(pattern, line));
}

/** Replaces the instructions (written last in the file) with a block scalar of `lines`. */
async function setInstructions(file: string, lines: string[]): Promise<void> {
  const text = await readFile(file, "utf8");
  const at = text.search(/^instructions:/m);
  expect(at).toBeGreaterThan(-1);
  await writeFile(
    file,
    `${text.slice(0, at)}instructions: |-\n${lines.map((l) => `  ${l}`).join("\n")}\n`,
  );
}

const SAME_FIELDS = (agent: AgentView) => ({
  name: agent.name,
  persona: agent.persona,
  runtime: agent.runtime,
  model: agent.model,
  thinkingLevel: agent.thinkingLevel,
  machineId: agent.machineId,
  plugins: agent.plugins,
  instructions: agent.instructions,
});

describe("/agent", () => {
  it("applies new multi-line instructions and thinking level, sending only those keys", async () => {
    const { r, agent, updates } = await start([
      async (file) => {
        await setLine(file, "thinkingLevel", "thinkingLevel: high");
        await setInstructions(file, ["First new line", "Second new line"]);
        return 0;
      },
    ]);
    await r.runCommand("/agent Ada");
    await r.waitFor("Updated Ada");
    expect(updates()).toEqual([
      {
        agentId: agent.id,
        instructions: "First new line\nSecond new line",
        thinkingLevel: "high",
      },
    ]);
    const after = await onHost(r, agent.id);
    expect(after).toMatchObject({
      ...SAME_FIELDS(agent),
      instructions: "First new line\nSecond new line",
      thinkingLevel: "high",
    });
  });

  it("exports the agent as the host has it: keys in order, a block scalar, an English guide", async () => {
    const { r, agent, seen } = await start([], {
      create: { instructions: "Line one\nLine two", thinkingLevel: "low" },
    });
    await r.runCommand("/agent Ada");
    await r.waitFor("No changes to Ada");
    const text = seen[0] ?? "";
    const keys = text
      .split(/\r?\n/)
      .filter((line) => /^\w+:/.test(line))
      .map((line) => line.slice(0, line.indexOf(":")));
    expect(keys).toEqual(KEY_ORDER);
    expect(text).toMatch(
      /^instructions: \|-?\r?\n {2}Line one\r?\n {2}Line two/m,
    );
    const comments = text.split(/\r?\n/).filter((line) => line.startsWith("#"));
    expect(comments.length).toBeGreaterThan(3);
    expect(text.split(/\r?\n/)[0]).toMatch(/^#/);
    expect(comments.join("\n")).toMatch(/save.*close.*apply/i);
    expect(comments.join("\n")).not.toMatch(/\p{Script=Han}/u);
    // The configured provider's model and the host's primary machine are offered.
    expect(comments.join("\n")).toContain("a:m1");
    expect(parseDocument(text).toJS()).toEqual(SAME_FIELDS(agent));
    expect(SAME_FIELDS(agent)).toMatchObject({
      instructions: "Line one\nLine two",
      thinkingLevel: "low",
    });
  });

  it("exports what the host has now after another reader subscribed to agents and let go", async () => {
    const { r, agent, seen } = await start([]);
    const release = r.wire.subscribe("agents");
    await r.waitUntil(
      () =>
        (
          r.wire.store.getState().targets.agents?.sections.list as
            | AgentView[]
            | undefined
        )?.some((a) => a.id === agent.id) === true,
      "the agents' state with Ada",
    );
    release();
    await r.wire.call("agents", "update", {
      agentId: agent.id,
      instructions: "Changed on the host",
    });
    await r.runCommand("/agent Ada");
    await r.waitUntil(() => seen.length === 1, "the editor to open");
    expect(parseDocument(seen[0] ?? "").toJS()).toMatchObject({
      instructions: "Changed on the host",
    });
  });

  it("puts the file in the system's temporary directory, named after the agent, and removes it after applying", async () => {
    const { r, agent, files } = await start([
      async (file) => {
        await setLine(file, "thinkingLevel", "thinkingLevel: max");
        return 0;
      },
    ]);
    await r.runCommand("/agent Ada");
    await r.waitFor("Updated Ada");
    const file = files[0] ?? "";
    expect(dirname(file)).toBe(tmpdir());
    expect(basename(file)).toContain(agent.id);
    expect(basename(file)).toMatch(/\.yaml$/);
    await r.waitUntil(() => !existsSync(file), "the file to go");
  });

  it("shows where the YAML broke, reopens the same file as the user left it, and applies the fix", async () => {
    const broken = "name: Ada\nplugins: [notes\nthinkingLevel: high\n";
    const { r, agent, files, seen } = await start([
      async (file) => {
        await writeFile(file, broken);
        return 0;
      },
      async (file) => {
        await writeFile(file, "name: Ada\nthinkingLevel: high\n");
        return 0;
      },
    ]);
    await r.runCommand("/agent Ada");
    await r.waitFor(/line \d+, column \d+/);
    expect(r.screen()).toMatch(/Enter/);
    await r.press(KEYS.enter);
    await r.waitFor("Updated Ada");
    expect(files).toHaveLength(2);
    expect(files[1]).toBe(files[0]);
    expect(seen[1]).toBe(broken);
    expect((await onHost(r, agent.id))?.thinkingLevel).toBe("high");
  });

  it("names the key of every invalid field", async () => {
    const { r, updates } = await start([
      async (file) => {
        await setLine(file, "name", 'name: ""');
        await setLine(file, "thinkingLevel", "thinkingLevel: hgh");
        await setLine(file, "model", "model: gpt4\ncolour: red");
        return 0;
      },
    ]);
    await r.runCommand("/agent Ada");
    await r.waitFor("colour");
    const screen = r.screen();
    const lines = screen.split("\n");
    for (const [key, value] of [
      ["name", undefined],
      ["thinkingLevel", "hgh"],
      ["model", "gpt4"],
      ["colour", undefined],
    ] as const) {
      const line = lines.find(
        (l) => l.includes(key) && (value === undefined || l.includes(value)),
      );
      expect(line, `a line about ${key}`).toBeDefined();
    }
    expect(updates()).toEqual([]);
  });

  it("shows the host's words when it refuses, and applies what is fixed after Enter", async () => {
    const { r, agent, updates } = await start([
      async (file) => {
        await setLine(file, "machineId", "machineId: no-such-machine");
        await setLine(file, "thinkingLevel", "thinkingLevel: medium");
        return 0;
      },
      async (file) => {
        expect(await readFile(file, "utf8")).toContain("no-such-machine");
        await setLine(file, "machineId", "machineId: null");
        return 0;
      },
    ]);
    await r.runCommand("/agent Ada");
    await r.waitFor("no such machine: no-such-machine");
    await r.press(KEYS.enter);
    await r.waitFor("Updated Ada");
    expect(updates()).toEqual([
      {
        agentId: agent.id,
        machineId: "no-such-machine",
        thinkingLevel: "medium",
      },
      { agentId: agent.id, thinkingLevel: "medium" },
    ]);
    expect(await onHost(r, agent.id)).toMatchObject({
      machineId: null,
      thinkingLevel: "medium",
    });
  });

  it("does not call agents.update when nothing changed", async () => {
    const { r, agent, files, updates } = await start([() => 0]);
    await r.runCommand("/agent Ada");
    await r.waitFor("No changes to Ada");
    expect(updates()).toEqual([]);
    await r.waitUntil(() => !existsSync(files[0] ?? ""), "the file to go");
    expect(await onHost(r, agent.id)).toMatchObject(SAME_FIELDS(agent));
  });

  it("changes nothing and removes the file when the editor did not run to the end", async () => {
    const { r, agent, files, updates } = await start([
      async (file) => {
        await setLine(file, "thinkingLevel", "thinkingLevel: high");
        return null;
      },
    ]);
    await r.runCommand("/agent Ada");
    await r.waitUntil(() => files.length === 1, "the editor to open");
    await r.waitUntil(() => !existsSync(files[0] ?? ""), "the file to go");
    await r.settle(300);
    expect(updates()).toEqual([]);
    expect(files).toHaveLength(1);
    expect(await onHost(r, agent.id)).toMatchObject(SAME_FIELDS(agent));
  });

  it("discards on Esc: the file goes, the status says nothing changed", async () => {
    const { r, agent, files, updates } = await start([
      async (file) => {
        await setLine(file, "thinkingLevel", "thinkingLevel: hgh");
        return 0;
      },
    ]);
    await r.runCommand("/agent Ada");
    await r.waitFor("hgh");
    await r.press(KEYS.escape);
    await r.waitFor("No changes to Ada");
    await r.waitForGone("hgh");
    await r.waitUntil(() => !existsSync(files[0] ?? ""), "the file to go");
    expect(files).toHaveLength(1);
    expect(updates()).toEqual([]);
    expect(await onHost(r, agent.id)).toMatchObject(SAME_FIELDS(agent));
  });

  it("removes the file, keeping a copy of what the user wrote, when the shell goes away with the problems still shown", async () => {
    const marker = `shown-${Date.now()}`;
    const { r, files } = await start([
      async (file) => {
        await setLine(file, "thinkingLevel", "thinkingLevel: hgh");
        await setInstructions(file, [marker]);
        return 0;
      },
    ]);
    await r.runCommand("/agent Ada");
    await r.waitFor("hgh");
    expect(existsSync(files[0] ?? "")).toBe(true);
    await r.controller.stop();
    await r.waitUntil(() => !existsSync(files[0] ?? ""), "the file to go");
    expect(files).toHaveLength(1);
    const kept = await keptFilesWith(marker, files[0] ?? "");
    expect(kept).toHaveLength(1);
    for (const path of kept) await rm(path, { force: true });
  });

  it("does not overwrite a change made on the host while the file was open, and keeps the user's version", async () => {
    let saved = "";
    const session: Session = await start([
      async (file) => {
        await session.r.wire.call("agents", "update", {
          agentId: session.agent.id,
          instructions: "Changed meanwhile",
        });
        await setLine(file, "thinkingLevel", "thinkingLevel: high");
        return 0;
      },
      async (file) => {
        const text = await readFile(file, "utf8");
        // The file now holds what the host has, and names where the user's version went.
        expect(parseDocument(text).toJS()).toMatchObject({
          instructions: "Changed meanwhile",
          thinkingLevel: null,
        });
        const comments = text
          .split(/\r?\n/)
          .filter((line) => line.startsWith("#"))
          .join("\n");
        saved = /(\S+\.yaml)/.exec(comments)?.[1] ?? "";
        expect(saved).not.toBe("");
        expect(saved).not.toBe(file);
        expect(await readFile(saved, "utf8")).toMatch(/^thinkingLevel: high$/m);
        await setLine(file, "thinkingLevel", "thinkingLevel: high");
        return 0;
      },
    ]);
    const { r, agent, files, updates } = session;
    const userUpdates = () =>
      updates().filter(
        (args) =>
          (args as { thinkingLevel?: unknown }).thinkingLevel !== undefined,
      );
    await r.runCommand("/agent Ada");
    await r.waitFor("changed on the host");
    expect(userUpdates()).toEqual([]);
    expect((await onHost(r, agent.id))?.thinkingLevel).toBeNull();
    await r.press(KEYS.enter);
    await r.waitFor("Updated Ada");
    expect(files).toHaveLength(2);
    expect(files[1]).toBe(files[0]);
    expect(userUpdates()).toEqual([
      { agentId: agent.id, thinkingLevel: "high" },
    ]);
    expect(await onHost(r, agent.id)).toMatchObject({
      instructions: "Changed meanwhile",
      thinkingLevel: "high",
    });
    await r.waitUntil(() => !existsSync(saved), "the saved version to go");
  });

  it("shows the host's words when the agent was deleted while being edited", async () => {
    const session: Session = await start([
      async (file) => {
        await session.r.wire.call("agents", "delete", {
          agentId: session.agent.id,
        });
        await setLine(file, "thinkingLevel", "thinkingLevel: high");
        return 0;
      },
    ]);
    const { r, agent, files } = session;
    await r.runCommand("/agent Ada");
    await r.waitFor(`no such agent: ${agent.id}`);
    await r.press(KEYS.escape);
    await r.waitFor("No changes to Ada");
    await r.waitUntil(() => !existsSync(files[0] ?? ""), "the file to go");
  });

  it("asks which agent when none is named, then edits the one picked", async () => {
    const { r, agent, updates } = await start([
      async (file) => {
        await setLine(file, "thinkingLevel", "thinkingLevel: minimal");
        return 0;
      },
    ]);
    await r.wire.call("agents", "create", {
      name: "Bea",
      model: "fake:fake-model",
    });
    await r.runCommand("/agent");
    await r.waitFor("Bea");
    await r.waitFor("Ada");
    // The list is in the host's order; walk to Ada whichever line it is on.
    for (let i = 0; i < 3 && !/›\s*Ada/.test(r.screen()); i += 1)
      await r.press(KEYS.down);
    expect(r.screen()).toMatch(/›\s*Ada/);
    await r.press(KEYS.enter);
    await r.waitFor("Updated Ada");
    expect(updates()).toEqual([
      { agentId: agent.id, thinkingLevel: "minimal" },
    ]);
  });

  it("asks which agent when the name fits several", async () => {
    const { r } = await start([]);
    await r.wire.call("agents", "create", {
      name: "Adam",
      model: "fake:fake-model",
    });
    await r.runCommand("/agent Ad");
    await r.waitFor("Adam");
    expect(r.screen()).toContain("Ada");
    expect(r.launches).toEqual([]);
  });

  it("says so when no agent fits the name, and opens nothing", async () => {
    const { r } = await start([]);
    await r.runCommand("/agent Zed");
    await r.waitFor("No agent matches Zed");
    expect(r.launches).toEqual([]);
  });
});

/**
 * Moves the shell to the host `other` (a new wire, so a new shell) and waits for it. Returns
 * the list the calls on the new wire are recorded in, as `target.action`.
 */
async function moveToOtherHost(
  r: HostRendered,
  other: Awaited<ReturnType<typeof testHost>>,
): Promise<string[]> {
  const before = r.controller.getState().wire;
  await r.controller.connectResident({ url: baseUrl(other) });
  await r.waitUntil(
    () =>
      r.controller.getState().phase.name === "connected" &&
      r.controller.getState().wire !== before,
    "the shell on the other host",
  );
  const moved = r.controller.getState().wire!;
  const calls: string[] = [];
  const call = moved.call.bind(moved);
  vi.spyOn(moved, "call").mockImplementation(
    async (target: string, action: string, ...rest: unknown[]) => {
      calls.push(`${target}.${action}`);
      return call(target, action, ...(rest as []));
    },
  );
  return calls;
}

/** Files in the temporary directory, other than `except`, that hold `marker`. */
async function keptFilesWith(
  marker: string,
  except: string,
): Promise<string[]> {
  const found: string[] = [];
  for (const name of await readdir(tmpdir())) {
    if (!name.startsWith("eta-agent-")) continue;
    const path = join(tmpdir(), name);
    if (path === except) continue;
    const text = await readFile(path, "utf8").catch(() => "");
    if (text.includes(marker)) found.push(path);
  }
  return found;
}

/**
 * Makes `targets` read as ones the host does not have, from the next subscription on: the store
 * marks them missing, as the host's `target:missing` answer does. The test host always mounts its
 * bundled plugins (`startHost` takes no list of them), so a missing target cannot be made there.
 * Call it once per test: a second spy on `subscribe` would replace the first.
 */
function hideTargets(r: HostRendered, targets: readonly string[]): void {
  const subscribe = r.wire.subscribe.bind(r.wire);
  vi.spyOn(r.wire, "subscribe").mockImplementation((name: string) => {
    if (!targets.includes(name)) return subscribe(name);
    r.wire.store.setState((state) => ({
      missing: { ...state.missing, [name]: true },
    }));
    return () => {};
  });
}

describe("/agent when things go wrong around the edit", () => {
  it("keeps what the user wrote, sends nothing and does not hang when the shell ended during the edit", async () => {
    const marker = `unsent-${Date.now()}`;
    const session: Session = await start([
      async (file) => {
        await session.r.controller.stop();
        await setInstructions(file, [marker]);
        return 0;
      },
    ]);
    const { r, files, updates } = session;
    await r.runCommand("/agent Ada");
    await r.waitUntil(() => files.length === 1, "the editor to open");
    await r.waitUntil(() => !existsSync(files[0] ?? ""), "the edit to end");
    const kept = await keptFilesWith(marker, files[0] ?? "");
    expect(kept).toHaveLength(1);
    expect(updates()).toEqual([]);
    for (const path of kept) await rm(path, { force: true });
  });

  it("sends nothing to another host the shell moved to during the edit, keeps what the user wrote and shows where", async () => {
    const marker = `moved-${Date.now()}`;
    const other = await testHost();
    let otherCalls: string[] = [];
    const session: Session = await start(
      [
        async (file) => {
          otherCalls = await moveToOtherHost(session.r, other);
          await setLine(file, "thinkingLevel", "thinkingLevel: high");
          await setInstructions(file, [marker]);
          return 0;
        },
      ],
      { columns: 220 },
    );
    const { r, files, updates } = session;
    await r.runCommand("/agent Ada");
    await r.waitUntil(() => files.length === 1, "the editor to open");
    await r.waitUntil(() => !existsSync(files[0] ?? ""), "the edit to end");
    expect(otherCalls.filter((c) => c === "agents.update")).toEqual([]);
    expect(updates()).toEqual([]);
    const kept = await keptFilesWith(marker, files[0] ?? "");
    expect(kept).toHaveLength(1);
    // The status line says so in short; the full path is in a layer of the new shell.
    await r.waitFor("Nothing was sent");
    await r.waitFor(kept[0]!);
    for (const path of kept) await rm(path, { force: true });
  });

  it("keeps both of the user's versions when the shell moves while editing again after a conflict", async () => {
    const first = `first-${Date.now()}`;
    const second = `second-${Date.now()}`;
    const other = await testHost();
    const session: Session = await start(
      [
        async (file) => {
          await session.r.wire.call("agents", "update", {
            agentId: session.agent.id,
            thinkingLevel: "low",
          });
          await setInstructions(file, [first]);
          return 0;
        },
        async (file) => {
          await moveToOtherHost(session.r, other);
          await setInstructions(file, [second]);
          return 0;
        },
      ],
      { columns: 220 },
    );
    const { r, files } = session;
    await r.runCommand("/agent Ada");
    await r.waitFor("changed on the host");
    await r.press(KEYS.enter);
    await r.waitUntil(() => files.length === 2, "the second opening");
    await r.waitUntil(() => !existsSync(files[0] ?? ""), "the edit to end");
    const keptFirst = await keptFilesWith(first, files[0] ?? "");
    const keptSecond = await keptFilesWith(second, files[0] ?? "");
    expect(keptFirst).toHaveLength(1);
    expect(keptSecond).toHaveLength(1);
    await r.waitFor(keptFirst[0]!);
    await r.waitFor(keptSecond[0]!);
    for (const path of [...keptFirst, ...keptSecond])
      await rm(path, { force: true });
  });

  it("sends the update to no other host when the shell moves while the agent is checked before it", async () => {
    const other = await testHost();
    let hooked = false;
    let otherCalls: string[] | undefined;
    const session: Session = await start([
      async (file) => {
        const { r } = session;
        const subscribe = r.wire.subscribe.bind(r.wire);
        // The check before the update reads `agents`: the shell moves while it waits, and the
        // copy it then finds is the one from the export (no conflict), so the update comes next.
        vi.spyOn(r.wire, "subscribe").mockImplementation((name: string) => {
          if (name !== "agents" || hooked) return subscribe(name);
          hooked = true;
          const exported = r.wire.store.getState().targets.agents!;
          void moveToOtherHost(r, other).then((calls) => {
            otherCalls = calls;
            r.wire.store.setState((state) => ({
              targets: {
                ...state.targets,
                agents: { ...exported, version: 1 },
              },
            }));
          });
          return () => {};
        });
        await setLine(file, "thinkingLevel", "thinkingLevel: high");
        return 0;
      },
    ]);
    const { r, files } = session;
    await r.runCommand("/agent Ada");
    await r.waitUntil(() => files.length === 1, "the editor to open");
    await r.waitUntil(() => !existsSync(files[0] ?? ""), "the edit to end");
    expect(otherCalls).toBeDefined();
    expect(otherCalls!.filter((c) => c === "agents.update")).toEqual([]);
  });

  it("opens no editor when the shell moves to another host before the file is written", async () => {
    const other = await testHost();
    let otherCalls: string[] | undefined;
    const { r, realCall } = await start([]);
    // The guide's lists are read before the export; the shell moves while they are.
    vi.mocked(r.wire.call).mockImplementation(
      async (target: string, action: string, ...rest: unknown[]) => {
        if (
          target === "agents" &&
          action === "runtimes" &&
          otherCalls === undefined
        )
          otherCalls = await moveToOtherHost(r, other);
        return realCall(target, action, ...(rest as []));
      },
    );
    await r.runCommand("/agent Ada");
    await r.waitFor("Nothing was opened");
    await r.settle(300);
    expect(r.launches).toEqual([]);
    expect(otherCalls).toBeDefined();
    expect(otherCalls!.filter((c) => c === "agents.update")).toEqual([]);
  });

  it("keeps a broken file the user wrote and does not hang when the shell ended during the edit", async () => {
    const marker = `broken-${Date.now()}`;
    const session: Session = await start([
      async (file) => {
        await session.r.controller.stop();
        await writeFile(file, `name: [${marker}\n`);
        return 0;
      },
    ]);
    const { r, files } = session;
    await r.runCommand("/agent Ada");
    await r.waitUntil(() => files.length === 1, "the editor to open");
    await r.waitUntil(() => !existsSync(files[0] ?? ""), "the edit to end");
    const kept = await keptFilesWith(marker, files[0] ?? "");
    expect(kept).toHaveLength(1);
    for (const path of kept) await rm(path, { force: true });
  });

  it("keeps the file and offers another try when the host cannot be asked before the update", async () => {
    const session: Session = await start([
      async (file) => {
        hideTargets(session.r, ["agents"]);
        await setLine(file, "thinkingLevel", "thinkingLevel: high");
        return 0;
      },
      async (file) => {
        expect(await readFile(file, "utf8")).toMatch(/^thinkingLevel: high$/m);
        return 0;
      },
    ]);
    const { r, files, updates } = session;
    await r.runCommand("/agent Ada");
    await r.waitFor("Enter to edit the file again");
    expect(existsSync(files[0] ?? "")).toBe(true);
    expect(updates()).toEqual([]);
    await r.press(KEYS.enter);
    await r.waitUntil(() => files.length === 2, "the second opening");
    expect(files[1]).toBe(files[0]);
  });

  it("exports the agent with a note when the guide's lists cannot be read", async () => {
    const { r, seen } = await start([]);
    hideTargets(r, ["personas", "providers"]);
    await r.runCommand("/agent Ada");
    await r.waitFor("No changes to Ada");
    const comments = (seen[0] ?? "")
      .split(/\r?\n/)
      .filter((line) => line.startsWith("#"));
    expect(
      comments.some(
        (line) => /could not list/i.test(line) && line.includes("persona"),
      ),
    ).toBe(true);
    expect(
      comments.some(
        (line) => /could not list/i.test(line) && line.includes("model"),
      ),
    ).toBe(true);
    expect(parseDocument(seen[0] ?? "").toJS()).toMatchObject({ name: "Ada" });
  });

  it("reads the file back when the editor exits with a code other than 0", async () => {
    const { r, agent, updates } = await start([
      async (file) => {
        await setLine(file, "thinkingLevel", "thinkingLevel: high");
        return 1;
      },
    ]);
    await r.runCommand("/agent Ada");
    await r.waitFor("Updated Ada");
    expect(updates()).toEqual([{ agentId: agent.id, thinkingLevel: "high" }]);
  });

  it("opens one edit for two Enters read at once in the picker", async () => {
    const { r, files } = await start([]);
    await r.runCommand("/agent");
    await r.waitFor("Ada");
    await r.press(KEYS.enter + KEYS.enter);
    await r.waitFor("No changes to Ada");
    await r.settle(500);
    expect(files).toHaveLength(1);
  });
});
