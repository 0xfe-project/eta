import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kernelOn } from "@eta/core";
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
  const picture = defineTool({
    name: "picture",
    description: "A picture, with a caption.",
    parameters: Type.Object({}),
    execute: () => ({
      content: [
        { type: "text", text: "a dot" },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      ],
    }),
  });
  const session = await openSession({
    storage,
    models: models as never,
    cwd,
    esm: { root },
    tools: [echo as never, picture as never],
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
    if (process.platform === "win32") return;
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
    // The history holds the code; a run leaves no script file behind.
    expect(
      existsSync(join(root, "runs")) &&
        readdirSync(join(root, "runs")).some((f) => f.endsWith(".js")),
    ).toBe(false);
    expect(
      await session.kernel.tools.execute(
        "read_state",
        { key: "k" },
        { turn: 1, toolCallId: "r" },
      ),
    ).toMatchObject({ content: [{ text: "k: v" }] });
    session.stop();
  });

  it("hands the model the images a mirrored tool answered with, beside the script's result", async () => {
    const { session } = await open([
      call("esmrun", {
        script: 'import eta from "eta";\nawait eta.platform.picture({})',
      }),
      stop(),
    ]);
    session.kernel.nextRun(userMsg("go"));
    await session.runner.run();
    const result = session.runner
      .getTranscript()
      .find((m) => m.role === "toolResult" && m.toolCallId === "c-esmrun") as
      | { content: { type: string; text?: string; data?: string }[] }
      | undefined;
    expect(result?.content[0]?.text).toContain(
      "a dot\n[image: attached to this esmrun result]",
    );
    expect(result?.content[1]).toEqual({
      type: "image",
      data: "iVBORw0KGgo=",
      mimeType: "image/png",
    });
    session.stop();
  });

  it("attaches at most 8 images to one result, and says how many it left out", async () => {
    const { session } = await open([
      call("esmrun", {
        script:
          'import eta from "eta";\nfor (let i = 0; i < 10; i++) await eta.platform.picture({});\n"ok"',
      }),
      stop(),
    ]);
    session.kernel.nextRun(userMsg("go"));
    await session.runner.run();
    const result = session.runner
      .getTranscript()
      .find((m) => m.role === "toolResult" && m.toolCallId === "c-esmrun") as
      | { content: { type: string; text?: string }[] }
      | undefined;
    expect(
      result?.content.filter((part) => part.type === "image"),
    ).toHaveLength(8);
    expect(result?.content[0]?.text).toContain(
      "images: the tools answered with 10; the first 8 are attached, 2 left out.",
    );
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
      users.some(
        (u) => u.includes("Capability delta") && u.includes("self:double"),
      ),
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

describe("cancelling the realm", () => {
  /** Polls until `check` holds; the realm's first wake is not instant. */
  const until = async (check: () => boolean, ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return check();
  };

  /** A script that says it started, then parks on an await that never settles. */
  const parked = (marker: string) =>
    [
      'import { writeFile } from "node:fs/promises";',
      `await writeFile("${marker}", "");`,
      "await new Promise(() => undefined);",
      '"never"',
    ].join("\n");

  it("ends a run whose tool call is a script that never settles", async () => {
    const { session, cwd } = await open([
      call("esmrun", { script: parked("parked.txt") }),
      stop(),
    ]);
    session.kernel.nextRun(userMsg("go"));
    const run = session.runner.run();
    // Aborting before the script is parked would prove nothing: it has to be
    // sitting on the await when the cancellation arrives.
    expect(await until(() => existsSync(join(cwd, "parked.txt")), 5000)).toBe(
      true,
    );
    const started = Date.now();
    session.runner.abort();
    const status = await Promise.race([
      run.then((result) => result.status),
      new Promise<string>((resolve) =>
        setTimeout(resolve, 1500, "still running"),
      ),
    ]);
    expect(status).toBe("aborted");
    expect(Date.now() - started).toBeLessThan(1500);
    expect(session.runner.running).toBe(false);
    session.stop();
  });

  it("ends an evaluation whose script is parked when its signal aborts", async () => {
    const { session, cwd } = await open([]);
    const controller = new AbortController();
    const running = session.kernel.tools.execute(
      "esmrun",
      { script: parked("signal.txt") },
      { turn: 1, toolCallId: "c-parked", signal: controller.signal },
    );
    expect(await until(() => existsSync(join(cwd, "signal.txt")), 5000)).toBe(
      true,
    );
    controller.abort(new DOMException("cancelled by the test", "AbortError"));
    const outcome = await Promise.race([
      running.then(
        () => "returned",
        (error: unknown) => `threw: ${String(error)}`,
      ),
      new Promise<string>((resolve) =>
        setTimeout(resolve, 1500, "still running"),
      ),
    ]);
    expect(outcome).toBe("threw: AbortError: cancelled by the test");
    session.stop();
  });

  it("preserves completed and in-flight effects on abort without bleeding late completions into the next evaluation", async () => {
    let slowStarted!: () => void;
    const onSlowStarted = new Promise<void>((resolve) => {
      slowStarted = resolve;
    });
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    const slowTool = defineTool({
      name: "slow_gate",
      description: "Waits until released.",
      parameters: Type.Object({}),
      execute: async () => {
        slowStarted();
        await slowGate;
        return { content: [{ type: "text", text: "slow:done" }] };
      },
    });

    const root = await mkdtemp(join(tmpdir(), "esm-abort-root-"));
    const cwd = await mkdtemp(join(tmpdir(), "esm-abort-cwd-"));
    const session = await openSession({
      storage: new MemoryStorage(),
      models: fakeModels([
        call(
          "esmrun",
          {
            script: [
              'import eta from "eta";',
              'import { writeFile } from "node:fs/promises";',
              'await writeFile("done.txt", "ok");',
              'console.log("before-slow");',
              "await eta.platform.slow_gate({});",
              'await writeFile("after.txt", "late");',
            ].join("\n"),
          },
          "c-abort-effects",
        ),
        call(
          "esmrun",
          {
            script: [
              'import { writeFile } from "node:fs/promises";',
              'await writeFile("next.txt", "clean");',
              '"turn2"',
            ].join("\n"),
          },
          "c-next",
        ),
        stop("recovered"),
      ]) as never,
      cwd,
      esm: { root },
      tools: [slowTool as never],
    });

    const toolEnds: {
      toolCallId: string;
      result: unknown;
      isError: boolean;
    }[] = [];
    const unsub = kernelOn(session.kernel.ctx)("tool:end", (event) => {
      toolEnds.push({
        toolCallId: event.toolCallId,
        result: event.result,
        isError: event.isError,
      });
    });

    session.kernel.nextRun(userMsg("go"));
    const run1 = session.runner.run();
    await onSlowStarted;
    session.runner.abort();
    const res1 = await run1;
    expect(res1.status).toBe("aborted");
    expect(session.runner.running).toBe(false);

    const abortedEnd = toolEnds.find(
      (entry) => entry.toolCallId === "c-abort-effects",
    );
    expect(abortedEnd?.isError).toBe(true);
    const transcriptEntry = session.runner
      .getTranscript()
      .find(
        (m) => m.role === "toolResult" && m.toolCallId === "c-abort-effects",
      ) as
      | {
          isError?: boolean;
          content: { type: string; text?: string }[];
          details?: {
            aborted?: boolean;
            file?: string;
            effects?: { name: string; status: string }[];
          };
        }
      | undefined;

    expect(transcriptEntry?.isError).toBe(true);
    const text = transcriptEntry?.content[0]?.text ?? "";
    expect(text).toContain("Tool execution was cancelled before completion.");
    expect(text).toContain("fs.writeFile done.txt");
    expect(text).toContain("[aborted] eta.platform.slow_gate");
    expect(text).toContain("console:\nbefore-slow");
    expect(text).toContain("script:");
    expect(transcriptEntry?.details?.aborted).toBe(true);
    expect(transcriptEntry?.details?.effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "fs.writeFile", status: "ok" }),
        expect.objectContaining({
          name: "eta.platform.slow_gate",
          status: "aborted",
        }),
      ]),
    );
    expect(abortedEnd?.result).toMatchObject({
      isError: true,
      details: { aborted: true },
    });

    // Release the late promise and confirm its completion does not bleed into the next evaluation.
    releaseSlow();
    await new Promise((resolve) => setTimeout(resolve, 50));

    session.kernel.nextRun(userMsg("next"));
    const res2 = await session.runner.run();
    expect(res2.status).toBe("completed");
    expect(resultOf(session, "c-next")).toContain("turn2");
    const nextEntry = session.runner
      .getTranscript()
      .find((m) => m.role === "toolResult" && m.toolCallId === "c-next") as
      | { details?: { effects?: { name: string; detail: string }[] } }
      | undefined;
    expect(nextEntry?.details?.effects).toHaveLength(1);
    expect(nextEntry?.details?.effects?.[0]?.detail).toContain("next.txt");

    unsub();
    session.stop();
  });

  it("kills real shell child and grandchild processes on abort and records $ as aborted", async () => {
    if (process.platform === "win32") return;
    const { session, cwd } = await open([
      call(
        "esmrun",
        {
          script:
            "await $`sh -c 'echo $$ > shell.pid; sleep 30 & echo $! > grand.pid; wait'`;",
        },
        "c-shell-abort",
      ),
      stop(),
    ]);
    session.kernel.nextRun(userMsg("go"));
    const run = session.runner.run();

    expect(
      await until(
        () =>
          existsSync(join(cwd, "shell.pid")) &&
          existsSync(join(cwd, "grand.pid")),
        5000,
      ),
    ).toBe(true);
    const shellPid = Number(
      (await readFile(join(cwd, "shell.pid"), "utf8")).trim(),
    );
    const grandPid = Number(
      (await readFile(join(cwd, "grand.pid"), "utf8")).trim(),
    );

    const started = Date.now();
    session.runner.abort();
    const res = await run;
    expect(res.status).toBe("aborted");
    expect(Date.now() - started).toBeLessThan(1500);

    const isDead = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    };
    expect(await until(() => isDead(shellPid) && isDead(grandPid), 2000)).toBe(
      true,
    );

    const entry = session.runner
      .getTranscript()
      .find(
        (m) => m.role === "toolResult" && m.toolCallId === "c-shell-abort",
      ) as
      | { details?: { effects?: { name: string; status: string }[] } }
      | undefined;
    expect(entry?.details?.effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "$", status: "aborted" }),
      ]),
    );
    session.stop();
  });

  it("keeps a background $ saved on eta.state alive across normal turns and kills it on session.stop()", async () => {
    if (process.platform === "win32") return;
    const { session } = await open([
      call(
        "esmrun",
        {
          script:
            'import eta from "eta";\nconst p = $`sleep 30`;\neta.state.srv = p;\np.pid',
        },
        "c-bg-start",
      ),
      stop("started"),
      call("esmrun", { script: '"still-here"' }, "c-bg-check"),
      stop("checked"),
    ]);

    session.kernel.nextRun(userMsg("start"));
    const r1 = await session.runner.run();
    expect(r1.status).toBe("completed");
    const pid = Number(resultOf(session, "c-bg-start").split("\n")[0]?.trim());
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    expect(() => process.kill(pid, 0)).not.toThrow();

    session.kernel.nextRun(userMsg("next"));
    const r2 = await session.runner.run();
    expect(r2.status).toBe("completed");
    expect(resultOf(session, "c-bg-check")).toContain("still-here");
    expect(() => process.kill(pid, 0)).not.toThrow();

    session.stop();
    const dead = await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    }, 2000);
    expect(dead).toBe(true);
  });

  it("esmrunandkeep aborted mid-run does not register the capability and cleans up the new file", async () => {
    const { session, root, cwd } = await open([
      call(
        "esmrunandkeep",
        {
          name: "latecap",
          desc: "never finishes",
          script: [
            'import { writeFile } from "node:fs/promises";',
            "export default async () => {",
            '  await writeFile("cap-started.txt", "1");',
            "  await new Promise(() => {});",
            "};",
          ].join("\n"),
        },
        "c-keep-abort",
      ),
      stop(),
    ]);

    session.kernel.nextRun(userMsg("go"));
    const run = session.runner.run();
    expect(
      await until(() => existsSync(join(cwd, "cap-started.txt")), 5000),
    ).toBe(true);

    session.runner.abort();
    const res = await run;
    expect(res.status).toBe("aborted");

    expect(
      existsSync(join(root, "capabilities")) &&
        readdirSync(join(root, "capabilities")).some((f) =>
          f.startsWith("latecap."),
        ),
    ).toBe(false);
    const listed = await session.kernel.tools.execute(
      "list_capabilities",
      {},
      { turn: 1, toolCallId: "c-list" },
    );
    expect(JSON.stringify(listed)).not.toContain("latecap");

    // Also test direct tools.execute("esmrunandkeep", ..., { signal }) abort cleanup.
    const controller = new AbortController();
    const direct = session.kernel.tools.execute(
      "esmrunandkeep",
      {
        name: "directcap",
        desc: "never finishes",
        script: [
          'import { writeFile } from "node:fs/promises";',
          "export default async () => {",
          '  await writeFile("direct-started.txt", "1");',
          "  await new Promise(() => {});",
          "};",
        ].join("\n"),
      },
      { turn: 2, toolCallId: "c-direct-keep", signal: controller.signal },
    );
    expect(
      await until(() => existsSync(join(cwd, "direct-started.txt")), 5000),
    ).toBe(true);
    controller.abort(new DOMException("aborted", "AbortError"));
    await expect(direct).rejects.toThrow();
    expect(
      existsSync(join(root, "capabilities")) &&
        readdirSync(join(root, "capabilities")).some((f) =>
          f.startsWith("directcap."),
        ),
    ).toBe(false);

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
