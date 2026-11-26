import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalTransport } from "@eta/ssh";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareWorktree, removeWorktree } from "../src/tasks/workspace";

let dir: string;
const transport = new LocalTransport();
const sh = async (cmd: string) => {
  const r = await transport.run(cmd, { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(r.stderr);
  return r.stdout;
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "eta-worktree-"));
  await sh(
    `cd '${dir}' && mkdir repo && cd repo && git init -q && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init`,
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const make = () =>
  prepareWorktree(transport, {
    projectPath: join(dir, "repo"),
    projectId: "p",
    number: 7,
    root: `'${join(dir, "data")}'`,
  });

describe("removeWorktree", () => {
  it("removes a clean worktree and keeps its branch", async () => {
    const made = await make();
    expect(existsSync(made.path)).toBe(true);
    const said = await removeWorktree(transport, {
      projectPath: join(dir, "repo"),
      path: made.path,
    });
    expect(said).toBe("removed");
    expect(existsSync(made.path)).toBe(false);
    expect(
      await sh(`cd '${join(dir, "repo")}' && git branch --list eta/task-7`),
    ).toContain("eta/task-7");
    // A task brought back finds its branch again.
    expect(existsSync((await make()).path)).toBe(true);
  });

  it("leaves a worktree with uncommitted work", async () => {
    const made = await make();
    await writeFile(join(made.path, "wip.txt"), "unsaved");
    const said = await removeWorktree(transport, {
      projectPath: join(dir, "repo"),
      path: made.path,
    });
    expect(said).toBe("kept");
    expect(existsSync(join(made.path, "wip.txt"))).toBe(true);
  });

  it("says absent when there is nothing to remove", async () => {
    expect(
      await removeWorktree(transport, {
        projectPath: join(dir, "repo"),
        path: join(dir, "nowhere"),
      }),
    ).toBe("absent");
  });
});
