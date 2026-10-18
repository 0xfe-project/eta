/**
 * bash (ported from eta-agent's `test/harness/tools.test.ts`).
 *
 * What a model sees after a command, and what it must not be able to misread:
 * the output in arrival order, a note when the tail is all that fit, and a
 * failure that says which failure it was — a code, a timeout, an abort.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCallInfo } from "@eta/core";
import { getOrThrow } from "@eta/execution";
import { DEFAULT_MAX_LINES } from "@eta/execution/output";
import { NodeEnvironment } from "@eta/execution-node";
import { beforeAll, describe, expect, it } from "vitest";
import { createBashTool } from "../src/tools/bash";
import type { ExecutionToolContext } from "../src/tools/context";
import type { ToolResult } from "../src/tools/tool";

let directory = "";
let env: NodeEnvironment;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "eta-bash-"));
  env = new NodeEnvironment({ cwd: directory });
});

const run = (signal?: AbortSignal): ToolCallInfo =>
  ({
    turn: 1,
    toolCallId: "bash-1",
    toolContext: { env } satisfies ExecutionToolContext,
    ...(signal === undefined ? {} : { signal }),
  }) as ToolCallInfo;

const textOf = (result: ToolResult<unknown>): string =>
  result.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");

describe("bash", () => {
  it("runs a command in the working directory and returns both streams", async () => {
    const result = await createBashTool().execute(
      { command: "echo out; echo err >&2" },
      { call: run(), context: { env }, update: () => undefined },
    );
    const output = textOf(result);
    expect(output).toContain("out");
    expect(output).toContain("err");
  });

  it("says (no output) when there is nothing to show", async () => {
    const result = await createBashTool().execute(
      { command: "true" },
      { call: run(), context: { env }, update: () => undefined },
    );
    expect(textOf(result)).toBe("(no output)");
  });

  it("reports a non-zero exit as a failure that still carries the output", async () => {
    await expect(
      createBashTool().execute(
        { command: "echo before; exit 3" },
        { call: run(), context: { env }, update: () => undefined },
      ),
    ).rejects.toThrow(/before[\s\S]*Command exited with code 3/);
  });

  it("keeps the tail, and says where the whole output went", async () => {
    const result = await createBashTool().execute(
      { command: "seq 1 5000" },
      { call: run(), context: { env }, update: () => undefined },
    );
    const output = textOf(result);
    expect(result.details?.truncation?.truncated).toBe(true);
    expect(result.details?.truncation?.truncatedBy).toBe("lines");
    expect(output).toContain(
      `[Showing lines ${5000 - DEFAULT_MAX_LINES + 1}-5000 of 5000. Full output: `,
    );
    expect(output.trimEnd().endsWith("5000")).toBe(false); // the notice follows
    expect(output).toContain("5000\n\n[Showing lines");
    // The whole output is readable from where the notice points.
    const full = getOrThrow(
      await env.readTextFile(result.details?.fullOutputPath ?? ""),
    );
    expect(full.startsWith("1\n2\n")).toBe(true);
  });

  it("does not spill when nothing was cut", async () => {
    const result = await createBashTool().execute(
      { command: "echo short" },
      { call: run(), context: { env }, update: () => undefined },
    );
    expect(result.details).toBeUndefined();
  });

  it("reports a timeout with what was printed first", async () => {
    await expect(
      createBashTool().execute(
        { command: "echo starting; sleep 10", timeout: 0.2 },
        { call: run(), context: { env }, update: () => undefined },
      ),
    ).rejects.toThrow(/starting[\s\S]*Command timed out after 0.2 seconds/);
  });

  it("reports an abort", async () => {
    // Abort only once a live update shows `going`: the update is published after
    // the chunk is in the captured window, so the abort cannot outrun the output
    // however loaded the machine is — and what was printed must survive it.
    const controller = new AbortController();
    let printed = (): void => undefined;
    const going = new Promise<"printed">((resolve) => {
      printed = () => resolve("printed");
    });
    const pending = Promise.resolve(
      createBashTool().execute(
        { command: "echo going; sleep 10" },
        {
          call: run(controller.signal),
          context: { env },
          update: (partial) => {
            if (textOf(partial).includes("going")) printed();
          },
        },
      ),
    );
    // Handles the rejection now, so a failure below never leaves it unhandled.
    const settled = pending.then(
      () => "settled" as const,
      () => "settled" as const,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const first = await Promise.race([
        going,
        settled,
        new Promise<"no output">((resolve) => {
          timer = setTimeout(() => resolve("no output"), 3_000);
        }),
      ]);
      expect(first).toBe("printed");
    } finally {
      clearTimeout(timer);
      // Also the cleanup when the output never came: no `sleep 10` left behind.
      controller.abort();
    }
    await expect(pending).rejects.toThrow(/going[\s\S]*Command aborted/);
  });

  it("refuses a nonsense timeout before running anything", async () => {
    await expect(
      createBashTool().execute(
        { command: "echo hi", timeout: -1 },
        { call: run(), context: { env }, update: () => undefined },
      ),
    ).rejects.toThrow(/Invalid timeout/);
  });

  it("lets a host prepend a line and rewrite the command before it runs", async () => {
    const tool = createBashTool<ExecutionToolContext>({
      commandPrefix: "echo preamble",
      prepare: (execution) => {
        execution.command = `${execution.command} # prepared`;
        execution.env = { ETA_BASH_TEST: "injected" };
      },
    });
    const result = await tool.execute(
      { command: "echo $ETA_BASH_TEST" },
      { call: run(), context: { env }, update: () => undefined },
    );
    const output = textOf(result);
    expect(output).toContain("preamble");
    expect(output).toContain("injected");
  });
});
