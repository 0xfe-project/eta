import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorage } from "@eta/core/storage";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { openSession } from "../src/open";
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

const open = async (script: ReturnType<typeof stop>[]) => {
  const root = await mkdtemp(join(tmpdir(), "esm-root-"));
  const cwd = await mkdtemp(join(tmpdir(), "esm-cwd-"));
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
    storage: new MemoryStorage(),
    models: models as never,
    cwd,
    esm: { root },
    tools: [echo as never],
  });
  return { session, models, root, cwd };
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
      'await eta.state.set("k", "v");',
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
    ).toMatchObject({ content: [{ text: "v" }] });
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
      call("esmrunandkeep", keep, "c3"),
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
    expect(resultOf(session, "c3")).toContain("already exists");
    expect(resultOf(session, "c4")).toContain("10");
    expect(existsSync(join(root, "capabilities", "broken.js"))).toBe(false);

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
