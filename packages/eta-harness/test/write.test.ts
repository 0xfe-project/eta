import type { ToolCallInfo } from "@eta/core";
import type { FileError, Result } from "@eta/execution";
import type { ExecutionToolContext } from "../src/tools/context";
import type { ToolResult } from "../src/tools/tool";
/**
 * write (ported from eta-agent's `test/harness/tools.test.ts`).
 *
 * What it promises: the file is there afterwards, its parents were made, and an
 * existing file is replaced. What it also promises, less visibly: two writes to
 * one path never interleave — including when the first one is aborted mid-flight.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrThrow } from "@eta/execution";
import { NodeEnvironment } from "@eta/execution-node";
import { beforeAll, describe, expect, it } from "vitest";
import { createWriteTool } from "../src/tools/write";

let directory = "";
let env: NodeEnvironment;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "eta-write-"));
  env = new NodeEnvironment({ cwd: directory });
});

const run = (toolCallId = "write-1", signal?: AbortSignal) =>
  ({
    call: {
      turn: 1,
      toolCallId,
      ...(signal === undefined ? {} : { signal }),
    } as ToolCallInfo,
    context: { env } as ExecutionToolContext,
    update: () => undefined,
  }) satisfies Parameters<ReturnType<typeof createWriteTool>["execute"]>[1];

const textOf = (result: ToolResult<unknown>): string =>
  result.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");

/** A write that blocks until the test lets it go. */
class BlockingWriteEnv extends NodeEnvironment {
  readonly firstWriteStarted: Promise<void>;
  readonly stillWriting: Promise<void>;
  secondWriteStarted = false;
  private releaseWrite: () => void = () => {};
  private noteStarted: () => void = () => {};

  constructor(options: { cwd: string }) {
    super(options);
    this.firstWriteStarted = new Promise<void>((resolve) => {
      this.noteStarted = resolve;
    });
    this.stillWriting = new Promise<void>((resolve) => {
      this.releaseWrite = resolve;
    });
  }

  /** Let the blocked write finish. */
  letGo(): void {
    this.releaseWrite();
  }

  override async writeFile(
    path: string,
    content: string | Uint8Array,
    options?: { signal?: AbortSignal },
  ): Promise<Result<void, FileError>> {
    if (this.secondWriteStarted)
      throw new Error("a second write started before the first settled");
    this.noteStarted();
    await this.stillWriting;
    return await super.writeFile(path, content, options);
  }
}

describe("write", () => {
  it("writes a file and creates its parent directories", async () => {
    const result = await createWriteTool().execute(
      { path: "nested/dir/file.txt", content: "hello" },
      run(),
    );
    expect(textOf(result)).toBe("Successfully wrote to nested/dir/file.txt");
    expect(getOrThrow(await env.readTextFile("nested/dir/file.txt"))).toBe(
      "hello",
    );
  });

  it("overwrites an existing file, and tells the environment's failure", async () => {
    await env.writeFile("existing.txt", "old");
    await createWriteTool().execute(
      { path: "existing.txt", content: "new" },
      run("write-2"),
    );
    expect(getOrThrow(await env.readTextFile("existing.txt"))).toBe("new");
    // A path that is a directory fails the way the environment says it does.
    await env.createDir("a-directory");
    await expect(
      createWriteTool().execute(
        { path: "a-directory", content: "x" },
        run("write-3"),
      ),
    ).rejects.toThrow(/is a directory|EISDIR/i);
  });

  it("does not refuse to write outside the working directory", async () => {
    // No sandbox, as in eta-agent: cwd is where a session starts, not a cage.
    const result = await createWriteTool().execute(
      { path: join(directory, "absolute.txt"), content: "ok" },
      run("write-4"),
    );
    expect(textOf(result)).toContain("Successfully wrote");
    expect(getOrThrow(await env.readTextFile("absolute.txt"))).toBe("ok");
  });

  it("holds the mutation queue until an aborted write settles", async () => {
    const blocking = new BlockingWriteEnv({ cwd: directory });
    const context = { env: blocking } as ExecutionToolContext;
    const controller = new AbortController();
    const tool = createWriteTool();
    const first = tool.execute(
      { path: "shared.txt", content: "first\n" },
      {
        call: {
          turn: 1,
          toolCallId: "first",
          signal: controller.signal,
        } as ToolCallInfo,
        context,
        update: () => undefined,
      },
    );
    await blocking.firstWriteStarted;
    controller.abort();
    const second = tool.execute(
      { path: "shared.txt", content: "second\n" },
      {
        call: { turn: 1, toolCallId: "second" } as ToolCallInfo,
        context,
        update: () => undefined,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(blocking.secondWriteStarted).toBe(false);
    blocking.letGo();
    await expect(first).rejects.toThrow();
    await second;
    expect(getOrThrow(await blocking.readTextFile("shared.txt"))).toBe(
      "second\n",
    );
  });

  it("cleans up after itself", async () => {
    await env.cleanup();
    await rm(directory, { recursive: true, force: true });
  });
});
