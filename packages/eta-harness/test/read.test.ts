import type { ToolCallInfo } from "@eta/core";
import type { ExecutionToolContext } from "../src/tools/context";
import type { ToolResult } from "../src/tools/tool";
/**
 * read (ported from eta-agent's `test/harness/tools.test.ts`).
 *
 * What a model gets when it reads a file: the lines it asked for, and a notice
 * saying which lines those were and where to continue. Truncation is a head cut
 * with the same limits the shell uses, and the one line-too-long case is named
 * rather than cut silently.
 */
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrThrow } from "@eta/execution";
import { NodeEnvironment } from "@eta/execution-node";
import { DEFAULT_MAX_LINES } from "@eta/execution/output";
import { beforeAll, describe, expect, it } from "vitest";
import { createReadTool } from "../src/tools/read";

let directory = "";
let env: NodeEnvironment;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "eta-read-"));
  env = new NodeEnvironment({ cwd: directory });
});

const run = (signal?: AbortSignal) => ({
  call: {
    turn: 1,
    toolCallId: "read-1",
    ...(signal === undefined ? {} : { signal }),
  } as ToolCallInfo,
  context: { env } as ExecutionToolContext,
  update: () => undefined,
});

const textOutput = (result: ToolResult<unknown>): string =>
  result.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");

describe("read", () => {
  it("reads with offsets, limits, and a continuation notice", async () => {
    await env.writeFile(
      "test.txt",
      Array.from({ length: 100 }, (_v, index) => `Line ${index + 1}`).join(
        "\n",
      ),
    );
    const result = await createReadTool().execute(
      { path: "test.txt", offset: 41, limit: 20 },
      run(),
    );
    const output = textOutput(result);
    expect(output).not.toContain("Line 40");
    expect(output).toContain("Line 41");
    expect(output).toContain("Line 60");
    expect(output).not.toContain("Line 61");
    expect(output).toContain(
      "[40 more lines in file. Use offset=61 to continue.]",
    );
  });

  it("truncates a large file by line count, and says how to continue", async () => {
    await env.writeFile(
      "large.txt",
      Array.from({ length: 2500 }, (_v, index) => `Line ${index + 1}`).join(
        "\n",
      ),
    );
    const result = await createReadTool().execute({ path: "large.txt" }, run());
    expect(textOutput(result)).toContain(
      `[Showing lines 1-${DEFAULT_MAX_LINES} of 2500. Use offset=2001 to continue.]`,
    );
    expect(result.details?.truncation).toMatchObject({
      truncated: true,
      truncatedBy: "lines",
      totalLines: 2500,
      outputLines: DEFAULT_MAX_LINES,
    });
  });

  it("does not count a trailing newline as an extra line at the limit", async () => {
    await env.writeFile(
      "exact.txt",
      `${Array.from({ length: DEFAULT_MAX_LINES }).fill("x").join("\n")}\n`,
    );
    const result = await createReadTool().execute({ path: "exact.txt" }, run());
    expect(result.details).toBeUndefined();
    expect(textOutput(result)).not.toContain("Use offset=");
  });

  it("names a first line that exceeds the byte budget instead of cutting it", async () => {
    await env.writeFile("one-line.txt", "x".repeat(60 * 1024));
    const result = await createReadTool().execute(
      { path: "one-line.txt" },
      run(),
    );
    expect(textOutput(result)).toContain("[Line 1 is ");
    expect(textOutput(result)).toContain("Use bash: sed -n '1p' one-line.txt");
    expect(result.details?.truncation?.firstLineExceedsLimit).toBe(true);
  });

  it("rejects an offset beyond the file", async () => {
    await env.writeFile("short.txt", "one\ntwo\nthree");
    await expect(
      createReadTool().execute({ path: "short.txt", offset: 100 }, run()),
    ).rejects.toThrow("Offset 100 is beyond end of file (3 lines total)");
  });

  it("follows a path spelled with unicode spaces or a leading @", async () => {
    await env.writeFile("spaced name.txt", "content");
    expect(
      textOutput(
        await createReadTool().execute({ path: "spaced\u202Fname.txt" }, run()),
      ),
    ).toBe("content");
    expect(
      textOutput(
        await createReadTool().execute({ path: "@spaced name.txt" }, run()),
      ),
    ).toBe("content");
  });

  it("resolves a symlink to the file it points at", async () => {
    await env.writeFile("target.txt", "the target");
    await symlink(join(directory, "target.txt"), join(directory, "link.txt"));
    expect(
      textOutput(await createReadTool().execute({ path: "link.txt" }, run())),
    ).toBe("the target");
  });

  it("maps a missing file, a directory and a permission failure to messages", async () => {
    await expect(
      createReadTool().execute({ path: "nope.txt" }, run()),
    ).rejects.toThrow(/no such file|ENOENT/i);
    await env.createDir("a-directory");
    await expect(
      createReadTool().execute({ path: "a-directory" }, run()),
    ).rejects.toThrow(/is a directory|EISDIR/i);
  });

  it("stops reading when the run is aborted", async () => {
    await env.writeFile("later.txt", "content");
    const controller = new AbortController();
    controller.abort();
    await expect(
      createReadTool().execute({ path: "later.txt" }, run(controller.signal)),
    ).rejects.toThrow(/abort/i);
  });

  it("cleans up after itself", async () => {
    await env.cleanup();
    await rm(directory, { recursive: true, force: true });
    expect(getOrThrow(await env.absolutePath("."))).toBe(directory);
  });
});
