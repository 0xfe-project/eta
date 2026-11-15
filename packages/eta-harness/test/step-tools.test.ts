/**
 * The task and state tools.
 *
 * The claim under test is the one a snapshot cannot fake: a task list and a
 * stored key are *written down*, so reopening the session finds them. The tools
 * are thin over the kernel's ledger and the journal's KV — that thinness is what
 * makes "it is still there" a real assertion rather than an echo.
 */
import { SessionLog } from "@eta/core/session";
import { MemoryStorage } from "@eta/core/storage";
import { fakeModels } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { openSession } from "../src/open";
import { journaledKernel } from "../src/testing";
import { createStepTools } from "../src/tools/tasks";
import { toKernelTool } from "../src/tools/tool";

const _userMsg = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
  timestamp: 0,
});

/** A kernel with the step tools registered, as a deployment wires them. */
const call = { turn: 1, toolCallId: "c1" } as never;

function session() {
  const { kernel, journaling } = journaledKernel(
    SessionLog.create(new MemoryStorage()),
  );
  const tools = createStepTools(kernel.tasks);
  for (const tool of tools)
    kernel.tools.register(toKernelTool(tool, () => undefined));
  kernel.config.update({
    activeToolNames: tools.map((tool) => tool.name),
  });
  return { kernel, journaling };
}

const textOf = (result: unknown): string =>
  typeof result === "object" &&
  result !== null &&
  Array.isArray((result as { content?: unknown }).content)
    ? (result as { content: { type: string; text?: string }[] }).content
        .flatMap((part) => (part.type === "text" ? [part.text ?? ""] : []))
        .join("\n")
    : String(result);

describe("step tools", () => {
  it("creates, lists, reads and updates the session's own ledger", async () => {
    const { kernel } = session();
    const tools = kernel.tools;
    const created = await tools.execute(
      "create_step",
      { content: "write the tests", priority: "high" },
      call,
    );
    expect(textOf(created)).toContain("Created t1.");
    expect(textOf(created)).toContain("Updated steps.");
    const second = await tools.execute(
      "create_step",
      { content: "then ship it", deps: ["t1"] },
      call,
    );
    expect(textOf(second)).toContain("Created t2.");

    const listed = textOf(await tools.execute("list_steps", {}, call));
    expect(listed).toContain("<current_steps>");
    expect(listed).toContain("[ ] t1: write the tests");
    expect(listed).toContain("[ ] t2: then ship it");

    const one = textOf(await tools.execute("get_step", { id: "t2" }, call));
    expect(one).toContain('"dependsOn":["t1"]');

    await tools.execute("update_step", { id: "t1", status: "completed" }, call);
    const after = textOf(await tools.execute("list_steps", {}, call));
    expect(after).toContain("[x] t1: write the tests");
  });

  it("says so plainly when a task does not exist", async () => {
    const { kernel } = session();
    expect(
      textOf(await kernel.tools.execute("get_step", { id: "t99" }, call)),
    ).toBe("No step t99.");
    expect(
      textOf(
        await kernel.tools.execute(
          "update_step",
          { id: "t99", status: "completed" },
          call,
        ),
      ),
    ).toBe("No step t99.");
  });

  it("keeps the ledger across a restart, because it was written down", async () => {
    const storage = new MemoryStorage();
    const first = await openSession({ storage, models: fakeModels([]) });
    for (const tool of createStepTools(first.kernel.tasks)) {
      first.kernel.tools.register(toKernelTool(tool, () => undefined));
    }
    await first.kernel.tools.execute(
      "create_step",
      { content: "survive the restart" },
      call,
    );
    await first.kernel.tools.execute(
      "create_step",
      { content: "and keep its edges", deps: ["t1"] },
      call,
    );
    await first.journaling.flush();
    await first.kernel.dispose();

    const again = await openSession({ storage, models: fakeModels([]) });
    // A deployment installs its tools on every session it opens.
    for (const tool of createStepTools(again.kernel.tasks)) {
      again.kernel.tools.register(toKernelTool(tool, () => undefined));
    }
    const listed = textOf(
      await again.kernel.tools.execute("list_steps", {}, call),
    );
    expect(listed).toContain("[ ] t1: survive the restart");
    expect(listed).toContain("[ ] t2: and keep its edges");
    expect(again.tasks?.kept).toBe(2);
    await again.kernel.dispose();
  });
});
