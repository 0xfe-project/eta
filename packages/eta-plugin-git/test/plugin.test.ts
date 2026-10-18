/**
 * The `git` plugin on the wire (S31).
 *
 * The subject is the plugin's *contract with the floor*: it registers under its own name, and it
 * learns about sessions from the bus rather than by holding the session manager. The `wire`
 * service here is the real one, because a fake would let the plugin and the shell agree on
 * something that is not true.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WireService } from "@eta/server";
import { Context, Service } from "cordis";
import { afterEach, describe, expect, it } from "vitest";
import { GIT_ACTIONS, gitPlugin } from "../src/index";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  await child.exited;
}

/** A repository with a committed file, on a branch of its own. */
async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eta-git-plugin-"));
  roots.push(root);
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  await writeFile(join(root, "file.txt"), "one\n", "utf8");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "first");
  await git(root, "checkout", "-q", "-b", "work");
  return root;
}

async function until(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs)
      throw new Error("timed out waiting for the fact");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * The plugin loaded on a real wire service, with a stand-in for the `sessions` service.
 *
 * The stand-in is the *contract*: four methods the plugin may call. Using the real sessions plugin
 * here would make this test about the sessions plugin too; the integration test next door is where
 * the two meet for real.
 */
async function mounted() {
  const ctx = new Context();
  const wire = new WireService(ctx);
  const listeners = new Set<{
    opened(session: { id: string; cwd: string }): void;
    closed(id: string): void;
    focused(id: string | undefined): void;
    changed(session: { id: string; cwd: string }): void;
  }>();
  const announce = {
    opened: (session: { id: string; cwd: string }) => {
      for (const listener of listeners) listener.opened(session);
    },
    changed: (session: { id: string; cwd: string }) => {
      for (const listener of listeners) listener.changed(session);
    },
    closed: (id: string) => {
      for (const listener of listeners) listener.closed(id);
    },
    focused: (id: string | undefined) => {
      for (const listener of listeners) listener.focused(id);
    },
  };
  // The plugin injects `sessions`, so something has to provide it: a service, the same way the
  // sessions plugin does it.
  class SessionsStub extends Service {
    static readonly provide = "sessions";

    subscribe(
      listener: typeof listeners extends Set<infer L> ? L : never,
    ): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  }
  ctx.plugin(SessionsStub as never, undefined as never);
  ctx.plugin(gitPlugin as never, undefined as never);
  // `ctx.plugin` runs `apply` on a microtask; the registration is what the assertions read.
  await until(() => wire.descriptors().length > 0);
  return { ctx, wire, announce };
}

describe("mounted", () => {
  it("registers under its own name", async () => {
    const { wire } = await mounted();
    expect(
      wire
        .descriptors()
        .map((descriptor) => descriptor.name)
        .sort(),
    ).toEqual([...GIT_ACTIONS].map((action) => `git.${action}`).sort());
    // Its own state target, eager so a fresh client draws the badges from `hello`.
    expect(wire.registry.eagerTargets()).toContain("git");
  });

  it("reads a checkout when a session appears, and again when it changes", async () => {
    const root = await repository();
    const { wire, announce } = await mounted();
    const rows = (): {
      session: string;
      branch: string | null;
      dirty: number;
    }[] =>
      (wire.snapshot("git")?.sections.sessions as {
        session: string;
        branch: string | null;
        dirty: number;
      }[]) ?? [];

    announce.opened({ id: "s1", cwd: root });
    await until(() => rows().length === 1);
    expect(rows()[0]).toMatchObject({
      session: "s1",
      branch: "work",
      dirty: 0,
    });

    // A change in the checkout is a fact about the session, not a poll: the bus event is what
    // makes the plugin look again.
    await writeFile(join(root, "file.txt"), "one\ntwo\n", "utf8");
    announce.changed({ id: "s1", cwd: root });
    await until(() => rows()[0]?.dirty === 1);

    // A session that is not a checkout says so rather than disappearing.
    announce.opened({
      id: "s2",
      cwd: await mkdtemp(join(tmpdir(), "eta-not-git-")),
    });
    await until(() => rows().length === 2);
    expect(rows().find((row) => row.session === "s2")).toMatchObject({
      notGit: true,
      branch: null,
    });

    // And the session going away takes its row with it.
    announce.closed("s1");
    await until(() => rows().length === 1);
    expect(rows()[0]?.session).toBe("s2");
  });

  it("answers status and diff over its own actions", async () => {
    const root = await repository();
    await writeFile(join(root, "file.txt"), "one\nchanged\n", "utf8");
    const { wire } = await mounted();
    const status = (await wire.dispatch(
      {
        op: "call",
        target: "git",
        action: "status",
        args: { session: "s1", cwd: root },
      },
      { reply: () => undefined } as never,
    )) as { result?: { facts?: { branch: string | null; dirty: number } } };
    expect(status.result?.facts).toMatchObject({ branch: "work", dirty: 1 });

    const diff = (await wire.dispatch(
      {
        op: "call",
        target: "git",
        action: "diff",
        args: { cwd: root, path: "file.txt", kind: "worktree" },
      },
      { reply: () => undefined } as never,
    )) as { result?: { diff?: { text: string } | null } };
    expect(diff.result?.diff?.text).toContain("+changed");

    // A call that is missing what it needs is named as such, not answered with nothing.
    await expect(
      wire.dispatch(
        { op: "call", target: "git", action: "diff", args: { cwd: root } },
        {
          reply: () => undefined,
        } as never,
      ),
    ).rejects.toThrow(/needs a cwd and a path/);
  });

  it("takes its registrations with it when unloaded", async () => {
    const ctx = new Context();
    const wire = new WireService(ctx);
    class SessionsStub extends Service {
      static readonly provide = "sessions";
      subscribe(): () => void {
        return () => undefined;
      }
    }
    ctx.plugin(SessionsStub as never, undefined as never);
    const fiber = ctx.plugin(
      gitPlugin as never,
      undefined as never,
    ) as unknown as { dispose(): Promise<void> };
    await until(() => wire.descriptors().length > 0);
    await fiber.dispose();
    expect(wire.descriptors()).toEqual([]);
    expect(wire.snapshot("git")).toBeUndefined();
  });
});

describe("what a session's checkout looks like", () => {
  it("counts each group, which is what a badge shows", async () => {
    const root = await repository();
    await writeFile(join(root, "staged.txt"), "a\n", "utf8");
    await git(root, "add", "staged.txt");
    await writeFile(join(root, "file.txt"), "one\nchanged\n", "utf8");
    await writeFile(join(root, "loose.txt"), "x\n", "utf8");

    const { wire, announce } = await mounted();
    announce.opened({ id: "s1", cwd: root });
    const rows = (): { staged: number; dirty: number; untracked: number }[] =>
      (wire.snapshot("git")?.sections.sessions as {
        staged: number;
        dirty: number;
        untracked: number;
      }[]) ?? [];
    await until(() => rows().length === 1);
    expect(rows()[0]).toMatchObject({ staged: 1, dirty: 1, untracked: 1 });
  });
});
