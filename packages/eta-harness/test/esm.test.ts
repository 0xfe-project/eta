import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorage } from "@eta/core/storage";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { ESM_TOOL_NAMES } from "../src/esm";
import { openSession } from "../src/open";
import { Agent } from "../src/realm";
import { defineTool } from "../src/tools/tool";

const call = (name: string, args: Record<string, unknown>, id = `c-${name}`) =>
  assistantMessage({
    stopReason: "toolUse",
    content: [{ type: "toolCall" as const, id, name, arguments: args }],
  });
const stop = (text = "done") =>
  assistantMessage({ content: [{ type: "text", text }] });

const userMsg = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
  timestamp: 0,
});

/** The text of the tool result answering `id`, from the transcript. */
const resultOf = (
  session: Awaited<ReturnType<typeof openSession>>,
  id: string,
): string => {
  const found = session.runner
    .getTranscript()
    .find((m) => m.role === "toolResult" && m.toolCallId === id) as
    | { content: { type: string; text?: string }[] }
    | undefined;
  return found?.content.map((p) => p.text ?? "").join("") ?? "(no result)";
};

const open = async (
  script: ReturnType<typeof stop>[],
  reuse?: { storage: MemoryStorage; root: string; cwd: string },
) => {
  const root = reuse?.root ?? (await mkdtemp(join(tmpdir(), "esm-root-")));
  const cwd = reuse?.cwd ?? (await mkdtemp(join(tmpdir(), "esm-cwd-")));
  const storage = reuse?.storage ?? new MemoryStorage();
  const models = fakeModels(script);
  const echo = defineTool({
    name: "echo",
    description: "Echo the text back. Second sentence.",
    parameters: Type.Object({ text: Type.String() }),
    execute: (args) => ({
      content: [{ type: "text", text: `echo:${args.text}` }],
      details: { echoed: args.text },
    }),
  });
  const session = await openSession({
    storage,
    models: models as never,
    cwd,
    esm: { root },
    tools: [echo as never],
  });
  return { session, models, root, cwd, storage };
};

describe("esmrun", () => {
  it("is installed, and its description carries the realm d.ts from the tool table", async () => {
    const { session } = await open([]);
    expect(session.tools).toEqual(
      expect.arrayContaining([
        "esmrun",
        "esmrunandkeep",
        "list_capabilities",
        "read_state",
      ]),
    );
    const tool = session.kernel.tools.get("esmrun")!;
    expect(tool.description).toContain("echo(input: {");
    expect(tool.description).toContain("llm(input:");
    expect(tool.description).not.toContain("esmrunandkeep(input");
    session.stop();
  });

  it("runs a bare expression in the session cwd, mirrors tools, writes state and saves the script", async () => {
    const script = [
      'import eta from "eta";',
      'import { writeFile } from "node:fs/promises";',
      'await writeFile("hello.txt", "hi");',
      'eta.state.k = "v";',
      'const said = await eta.platform.echo({ text: "x" });',
      "const pwd = (await $`pwd`).stdout.trim();",
      '({ said, pwd, seen: await view("hello.txt") })',
    ].join("\n");
    const { session, root, cwd } = await open([
      call("esmrun", { script }),
      stop(),
    ]);
    session.kernel.nextRun(userMsg("go"));
    await session.runner.run();
    const text = resultOf(session, "c-esmrun");
    expect(text).toContain('"said": "echo:x"');
    expect(text).toContain('"seen": "1: hi"');
    expect(text).toContain(cwd.split("/").at(-1)!);
    expect(existsSync(join(cwd, "hello.txt"))).toBe(true);
    expect(readdirSync(join(root, "runs")).some((f) => f.endsWith(".js"))).toBe(
      true,
    );
    expect(
      await session.kernel.tools.execute(
        "read_state",
        { key: "k" },
        { turn: 1, toolCallId: "r" },
      ),
    ).toMatchObject({ content: [{ text: "k: v" }] });
    session.stop();
  });

  it("an error is a tool error, not a crash", async () => {
    const { session } = await open([
      call("esmrun", { script: "throw new Error('boom')" }),
      stop(),
    ]);
    session.kernel.nextRun(userMsg("go"));
    await session.runner.run();
    expect(resultOf(session, "c-esmrun")).toContain("boom");
    session.stop();
  });
});

describe("esmrunandkeep", () => {
  it("saves only after a run that worked, refuses a taken name, and the next run is told", async () => {
    const keep = {
      name: "double",
      desc: "doubles n",
      script: "export default ({ n }) => n * 2;",
      args: { n: 21 },
    };
    const { session, root } = await open([
      call(
        "esmrunandkeep",
        {
          ...keep,
          name: "broken",
          script: "export default () => { throw new Error('no'); }",
        },
        "c1",
      ),
      call("esmrunandkeep", keep, "c2"),
      call(
        "esmrunandkeep",
        { ...keep, script: "export default ({ n }) => n * 3;" },
        "c3",
      ),
      call("esmrunandkeep", keep, "c3b"),
      call(
        "esmrun",
        { script: 'import double from "eta:double";\nawait double({ n: 5 })' },
        "c4",
      ),
      stop(),
      stop("second"),
    ]);
    session.kernel.nextRun(userMsg("go"));
    await session.runner.run();
    expect(resultOf(session, "c1")).toContain("no");
    expect(resultOf(session, "c2")).toContain("saved double");
    expect(resultOf(session, "c2")).toContain("42");
    expect(resultOf(session, "c2")).toMatch(/effects:[\s\S]*define/);
    expect(resultOf(session, "c3")).toContain("already exists");
    // The same script again is define's no-op, not an error.
    expect(resultOf(session, "c3b")).toContain("saved double");
    expect(resultOf(session, "c4")).toContain("10");
    expect(
      readdirSync(join(root, "capabilities")).some((f) =>
        f.startsWith("broken."),
      ),
    ).toBe(false);
    // What define persisted works in a fresh realm, after a wake from env.js alone.
    const fresh = new Agent({ root });
    const again = await fresh.run(
      'import double from "eta:double";\nexport default await double({ n: 4 });',
    );
    expect(again.value).toBe(8);
    fresh.dispose();

    // The next run opens with the delta as a user message.
    session.kernel.nextRun(userMsg("again"));
    await session.runner.run();
    const users = session.runner
      .getTranscript()
      .filter((m) => m.role === "user")
      .map((m) => JSON.stringify(m.content));
    expect(
      users.some((u) => u.includes("能力 delta") && u.includes("self:double")),
    ).toBe(true);
    session.stop();
  });
});

describe("eta.ask", () => {
  it("runs a nested turn with the session's tools and history, and reports its stack", async () => {
    const { session, models } = await open([
      call("esmrun", {
        script: 'import eta from "eta";\n(await eta.ask("use echo")).text',
      }),
      // the nested turn: one tool call, then an answer
      call("echo", { text: "inner" }, "n1"),
      stop("nested answer"),
      stop(),
    ]);
    session.kernel.nextRun(userMsg("go"));
    await session.runner.run();
    const text = resultOf(session, "c-esmrun");
    expect(text).toContain("nested answer");
    expect(text).toContain("eta.ask [completed]");
    // The nested request saw the history, including a placeholder for the running call.
    const nested = models.calls[1]!.context.messages;
    expect(JSON.stringify(nested)).toContain("go");
    expect(nested.some((m) => m.role === "toolResult")).toBe(true);
    session.stop();
  });
});

describe("esmrun across calls", () => {
  it("does not keep a top-level const from one call to the next", async () => {
    const { session } = await open([
      call("esmrun", { script: "const a = 1" }, "r1"),
      call("esmrun", { script: "const b = a + 1; console.log(b)" }, "r2"),
      stop(),
    ]);
    session.kernel.nextRun(userMsg("go"));
    await session.runner.run();
    expect(resultOf(session, "r2")).toContain("a is not defined");
    session.stop();
  });

  it("carries any value through eta.state, and saves the JSON-able ones with the session", async () => {
    const first = await open([
      call(
        "esmrun",
        {
          script:
            'import eta from "eta";\neta.state.a = 1;\neta.state.cfg = { n: [1, 2] };\neta.state.fn = (x) => x * 10;',
        },
        "s1",
      ),
      call(
        "esmrun",
        {
          script:
            'import eta from "eta";\nconst b = eta.state.a + 1; console.log(b);\n({ b, n: eta.state.cfg.n, f: eta.state.fn(3) })',
        },
        "s2",
      ),
      stop(),
    ]);
    first.session.kernel.nextRun(userMsg("go"));
    await first.session.runner.run();
    const s2 = resultOf(first.session, "s2");
    expect(s2).toContain('"b": 2');
    expect(s2).toContain('"f": 30');
    expect(s2).toContain("console:\n2");
    // eta.state is not globalThis.
    expect(
      await first.session.kernel.tools.execute(
        "esmrun",
        { script: "typeof globalThis.a" },
        { turn: 1, toolCallId: "g" },
      ),
    ).toMatchObject({
      content: [{ text: expect.stringContaining("undefined") }],
    });
    const listed = await first.session.kernel.tools.execute(
      "read_state",
      {},
      { turn: 1, toolCallId: "r" },
    );
    expect(listed).toMatchObject({
      content: [
        {
          text: expect.stringContaining("fn: [function] (not saved: not JSON)"),
        },
      ],
    });
    first.session.stop();

    // Same journal, a fresh session: the JSON-able values come back, the function does not.
    const second = await open(
      [
        call(
          "esmrun",
          {
            script:
              'import eta from "eta";\n({ a: eta.state.a, n: eta.state.cfg.n, fn: typeof eta.state.fn })',
          },
          "s3",
        ),
        stop(),
      ],
      { storage: first.storage, root: first.root, cwd: first.cwd },
    );
    second.session.kernel.nextRun(userMsg("again"));
    await second.session.runner.run();
    const s3 = resultOf(second.session, "s3");
    expect(s3).toContain('"a": 1');
    expect(s3).toContain('"fn": "undefined"');
    expect(s3).toMatch(/"n": \[\s*1,\s*2\s*\]/);
    second.session.stop();
  });
});

describe("realm cwd", () => {
  it("search resolves in the session cwd", async () => {
    const { session, cwd } = await open([
      call("esmrun", { script: '(await search("needle")).map((r) => r.file)' }),
      stop(),
    ]);
    await writeFile(join(cwd, "a.txt"), "a needle here\n");
    session.kernel.nextRun(userMsg("go"));
    await session.runner.run();
    expect(resultOf(session, "c-esmrun")).toContain("a.txt");
    session.stop();
  });
});

describe("a session opened with the realm", () => {
  /** A storage that counts what lands in it, because a replay must add nothing. */
  class CountingStorage extends MemoryStorage {
    writes = 0;

    override async commit(...args: Parameters<MemoryStorage["commit"]>) {
      this.writes += args[0].length;
      return await super.commit(...args);
    }
  }

  /** A journal from before the realm: its session pinned `activeToolNames` back then. */
  const journalPinned = async (activeToolNames: string[]) => {
    const storage = new CountingStorage();
    const first = await openSession({
      storage,
      models: fakeModels([]) as never,
    });
    first.kernel.config.update({ activeToolNames });
    await first.journaling.flush();
    await first.kernel.dispose();
    first.stop();
    return storage;
  };

  const offered = (models: ReturnType<typeof fakeModels>) =>
    models.calls[0]?.context.tools?.map((tool) => tool.name) ?? [];

  it("offers the realm to a new session", async () => {
    const { session, models } = await open([stop()]);
    expect(session.config.activeToolNames).toEqual(
      expect.arrayContaining([...ESM_TOOL_NAMES]),
    );
    session.kernel.nextRun(userMsg("go"));
    await session.runner.run();
    expect(offered(models)).toEqual(
      expect.arrayContaining([...ESM_TOOL_NAMES]),
    );
    session.stop();
  });

  it("gives a pin that still names the tools the realm replaced the realm instead", async () => {
    const storage = await journalPinned([
      "create_step",
      "read",
      "bash",
      "Agent",
      "echo",
    ]);
    const { session, models } = await open(
      [
        call("esmrun", {
          script:
            'import eta from "eta";\nawait eta.platform.echo({ text: "x" })',
        }),
        stop(),
      ],
      {
        storage,
        root: await mkdtemp(join(tmpdir(), "esm-root-")),
        cwd: await mkdtemp(join(tmpdir(), "esm-cwd-")),
      },
    );
    expect(session.config.activeToolNames).toEqual([
      "create_step",
      "echo",
      ...ESM_TOOL_NAMES,
    ]);
    session.kernel.nextRun(userMsg("go"));
    await session.runner.run();
    expect(offered(models)).toEqual(
      expect.arrayContaining([...ESM_TOOL_NAMES]),
    );
    expect(resultOf(session, "c-esmrun")).toContain("echo:x");
    session.stop();
  });

  // The session the realm's rollout left behind: the opening that dropped `read` and `bash` is
  // already in its journal, so nothing is left to drop and the gap has to be read off the pin.
  it("gives the realm to a pin that already lost those tools, once", async () => {
    const storage = await journalPinned(["create_step", "echo"]);
    const reuse = {
      storage,
      root: await mkdtemp(join(tmpdir(), "esm-root-")),
      cwd: await mkdtemp(join(tmpdir(), "esm-cwd-")),
    };
    const first = await open([stop()], reuse);
    expect(first.session.config.activeToolNames).toEqual([
      "create_step",
      "echo",
      ...ESM_TOOL_NAMES,
    ]);
    first.session.kernel.nextRun(userMsg("go"));
    await first.session.runner.run();
    expect(offered(first.models)).toEqual(
      expect.arrayContaining([...ESM_TOOL_NAMES]),
    );
    await first.session.journaling.flush();
    await first.session.kernel.dispose();
    first.session.stop();

    const writes = storage.writes;
    const second = await open([], reuse);
    await second.session.journaling.flush();
    expect(second.session.config.activeToolNames).toEqual([
      "create_step",
      "echo",
      ...ESM_TOOL_NAMES,
    ]);
    expect(storage.writes).toBe(writes);
    await second.session.kernel.dispose();
    second.session.stop();
  });

  it("briefs a reopened session on the realm, with the tools it was pinned to in the d.ts", async () => {
    const storage = await journalPinned(["create_step", "echo"]);
    const cwd = await mkdtemp(join(tmpdir(), "esm-cwd-"));
    const models = fakeModels([stop()]);
    const echo = defineTool({
      name: "echo",
      description: "Echo the text back.",
      parameters: Type.Object({ text: Type.String() }),
      execute: (args) => ({
        content: [{ type: "text", text: args.text }],
        details: {},
      }),
    });
    const session = await openSession({
      storage,
      models: models as never,
      cwd,
      esm: { root: await mkdtemp(join(tmpdir(), "esm-root-")) },
      platform: {
        cwd,
        home: cwd,
        configPath: join(cwd, "config.json"),
        memoryTarget: join(cwd, ".eta", "MEMORY.md"),
        memoryExists: false,
      },
      tools: [echo as never],
    });
    session.kernel.nextRun(userMsg("go"));
    await session.runner.run();
    const request = models.calls[0]?.context;
    expect(request?.systemPrompt).toContain("You act through code.");
    const esmrun = request?.tools?.find((tool) => tool.name === "esmrun");
    expect(esmrun?.description).toContain("echo(input: {");
    expect(esmrun?.description).toContain("create_step(input: {");
    session.stop();
  });

  it("leaves a pin alone when the session has no realm", async () => {
    const storage = await journalPinned(["create_step"]);
    const session = await openSession({
      storage,
      models: fakeModels([]) as never,
    });
    expect(session.config.activeToolNames).toEqual(["create_step"]);
    await session.kernel.dispose();
    session.stop();
  });
});
