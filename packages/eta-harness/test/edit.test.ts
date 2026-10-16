import type { ToolCallInfo } from "@eta/core";
import type { ExecutionToolContext } from "../src/tools/context";
import type { ToolResult } from "../src/tools/tool";
/**
 * edit (ported from eta-agent's `test/harness/tools.test.ts`).
 *
 * The rules this pins, in the order a model trips over them: every edit matches
 * the *original* file, each target must be unique, targets may not overlap — and
 * the file's own shape (BOM, CRLF) survives. Editing through a symlink edits the
 * target, and two edits to the same file, however spelled, are serialized.
 */
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrThrow } from "@eta/execution";
import { NodeEnvironment } from "@eta/execution-node";
import { applyPatch } from "diff";
import { beforeAll, describe, expect, it } from "vitest";
import { createEditTool } from "../src/tools/edit";
import { toKernelTool } from "../src/tools/tool";

let directory = "";
let env: NodeEnvironment;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "eta-edit-"));
  env = new NodeEnvironment({ cwd: directory });
});

/**
 * The tool as the kernel sees it: adapted (so `prepareArguments` and the schema
 * check both run) and handed the environment the way the runner hands one over.
 */
const tool = () =>
  toKernelTool(
    createEditTool(),
    (toolContext) => toolContext as ExecutionToolContext,
  );

const run = (toolCallId = "edit-1", signal?: AbortSignal): ToolCallInfo =>
  ({
    turn: 1,
    toolCallId,
    toolContext: { env } satisfies ExecutionToolContext,
    ...(signal === undefined ? {} : { signal }),
  }) as ToolCallInfo;

const textOf = (result: ToolResult<unknown>): string =>
  result.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");

describe("edit", () => {
  it("applies disjoint edits, and returns both diff formats", async () => {
    const original = "alpha\nbeta\ngamma\ndelta\n";
    await env.writeFile("edit.txt", original);
    const result = await tool().execute(
      {
        path: "edit.txt",
        edits: [
          { oldText: "alpha\n", newText: "ALPHA\n" },
          { oldText: "gamma\n", newText: "GAMMA\n" },
        ],
      },
      run(),
    );
    expect(textOf(result)).toBe(
      "Successfully replaced 2 block(s) in edit.txt.",
    );
    expect(result.details?.diff).toContain("ALPHA");
    expect(result.details?.diff).toContain("GAMMA");
    // The patch really applies to the original, so a host can replay it.
    expect(applyPatch(original, result.details?.patch ?? "")).toBe(
      "ALPHA\nbeta\nGAMMA\ndelta\n",
    );
    expect(getOrThrow(await env.readTextFile("edit.txt"))).toBe(
      "ALPHA\nbeta\nGAMMA\ndelta\n",
    );
  });

  it("matches every edit against the original and refuses overlaps", async () => {
    await env.writeFile("overlap.txt", "one\ntwo\nthree\n");
    await expect(
      tool().execute(
        {
          path: "overlap.txt",
          edits: [
            { oldText: "one\ntwo\n", newText: "ONE\nTWO\n" },
            { oldText: "two\nthree\n", newText: "TWO\nTHREE\n" },
          ],
        },
        run(),
      ),
    ).rejects.toThrow(/overlap/);
    // Nothing was written by the failed call.
    expect(getOrThrow(await env.readTextFile("overlap.txt"))).toBe(
      "one\ntwo\nthree\n",
    );
  });

  it("refuses missing text, and text that is not unique", async () => {
    await env.writeFile("dup.txt", "foo foo foo");
    await expect(
      tool().execute(
        { path: "dup.txt", edits: [{ oldText: "bar", newText: "baz" }] },
        run("e2"),
      ),
    ).rejects.toThrow(/Could not find the exact text/);
    await expect(
      tool().execute(
        { path: "dup.txt", edits: [{ oldText: "foo", newText: "bar" }] },
        run("e3"),
      ),
    ).rejects.toThrow(/Found 3 occurrences/);
  });

  it("accepts what models actually send: a JSON string, one object, or the old field pair", async () => {
    await env.writeFile("loose.txt", "alpha\nbeta\n");
    const loose = tool();
    await loose.execute(
      {
        path: "loose.txt",
        edits: JSON.stringify([{ oldText: "alpha", newText: "A" }]),
      } as never,
      run("e4"),
    );
    expect(getOrThrow(await env.readTextFile("loose.txt"))).toBe("A\nbeta\n");
    await loose.execute(
      { path: "loose.txt", edits: { oldText: "beta", newText: "B" } } as never,
      run("e5"),
    );
    expect(getOrThrow(await env.readTextFile("loose.txt"))).toBe("A\nB\n");
    await loose.execute(
      { path: "loose.txt", oldText: "A", newText: "AA" } as never,
      run("e6"),
    );
    expect(getOrThrow(await env.readTextFile("loose.txt"))).toBe("AA\nB\n");
  });

  it("edits through a symlink, and serializes the two spellings of one file", async () => {
    await env.writeFile("target.txt", "alpha\nbeta\ngamma\n");
    await symlink("target.txt", join(directory, "link.txt"));
    const edit = tool();
    await Promise.all([
      edit.execute(
        { path: "target.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] },
        run("e7"),
      ),
      edit.execute(
        { path: "link.txt", edits: [{ oldText: "beta", newText: "BETA" }] },
        run("e8"),
      ),
    ]);
    // Both edits landed, and neither read a half-written file.
    expect(getOrThrow(await env.readTextFile("target.txt"))).toBe(
      "ALPHA\nBETA\ngamma\n",
    );
  });

  it("preserves a BOM and CRLF line endings", async () => {
    await env.writeFile("crlf.txt", "\uFEFFone\r\ntwo\r\n");
    await tool().execute(
      { path: "crlf.txt", edits: [{ oldText: "two", newText: "TWO" }] },
      run("e9"),
    );
    expect(getOrThrow(await env.readTextFile("crlf.txt"))).toBe(
      "\uFEFFone\r\nTWO\r\n",
    );
  });

  it("matches text that differs only in invisible ways", async () => {
    // A model that retyped the text with a normal space, or dropped trailing
    // whitespace, still lands the edit: those differences are not intent.
    await env.writeFile(
      "fuzzy.txt",
      "const\u00A0value = 1;   \nconst other = 2;\n",
    );
    await tool().execute(
      {
        path: "fuzzy.txt",
        edits: [
          { oldText: "const value = 1;\n", newText: "const value = 10;\n" },
        ],
      },
      run("e10"),
    );
    expect(getOrThrow(await env.readTextFile("fuzzy.txt"))).toBe(
      "const value = 10;\nconst other = 2;\n",
    );
  });

  it("refuses to edit a directory", async () => {
    await env.createDir("a-directory");
    await expect(
      tool().execute(
        { path: "a-directory", edits: [{ oldText: "x", newText: "y" }] },
        run("e11"),
      ),
    ).rejects.toThrow(/not a file/);
  });

  it("stops when the run is aborted", async () => {
    await env.writeFile("later.txt", "content\n");
    const controller = new AbortController();
    controller.abort();
    await expect(
      tool().execute(
        {
          path: "later.txt",
          edits: [{ oldText: "content", newText: "changed" }],
        },
        run("e12", controller.signal),
      ),
    ).rejects.toThrow(/abort/i);
    expect(getOrThrow(await env.readTextFile("later.txt"))).toBe("content\n");
  });

  it("cleans up after itself", async () => {
    await env.cleanup();
    await rm(directory, { recursive: true, force: true });
  });
});
