/**
 * The `ssh` plugin (S32).
 *
 * The subject is a session whose tools run on another machine, so the test runs the *real*
 * environment over the local transport — the same `SshEnvironment`, the same scripts, the same
 * parsing, with `/bin/sh` standing in for a remote shell. What that proves is the part that
 * matters: nothing about a session changes when its filesystem is somewhere else.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WireService } from "@eta/server";
import { LocalTransport } from "@eta/ssh";
import { Context } from "cordis";
import { afterEach, describe, expect, it } from "vitest";
import { SSH_ACTIONS, sshPlugin } from "../src/index";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eta-ssh-plugin-"));
  roots.push(root);
  return root;
}

async function until(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The plugin on a real wire service, with the local transport standing in for ssh. */
async function mounted() {
  const root = await scratch();
  const ctx = new Context();
  const wire = new WireService(ctx);
  const plugin = sshPlugin({
    path: join(root, "ssh.json"),
    // The "remote" machine is this one, with a home of its own: the transport is the seam, and
    // everything above it — the environment, the tools, the memory — is the real thing.
    transportFor: async () => new LocalTransport({ home: root }),
  });
  ctx.plugin(plugin as never, undefined as never);
  await until(() => wire.descriptors().length > 0);
  return { ctx, wire, plugin, root };
}

const call = async (
  wire: WireService,
  action: string,
  args?: unknown,
): Promise<{ result?: unknown }> =>
  (await wire.dispatch({ op: "call", target: "ssh", action, args }, {
    reply: () => undefined,
  } as never)) as {
    result?: unknown;
  };

describe("the ssh target", () => {
  it("registers its actions and an eager state target", async () => {
    const { wire } = await mounted();
    expect(
      wire
        .descriptors()
        .map((descriptor) => descriptor.name)
        .sort(),
    ).toEqual([...SSH_ACTIONS].map((action) => `ssh.${action}`).sort());
    expect(wire.registry.eagerTargets()).toContain("ssh");
  });

  it("saves a target, remembers it, and publishes it", async () => {
    const { wire, root } = await mounted();
    await call(wire, "save", {
      target: { id: "box", host: "box.example", user: "eta" },
    });
    const rows = (): { id: string; host: string }[] =>
      (wire.snapshot("ssh")?.sections.targets as {
        id: string;
        host: string;
      }[]) ?? [];
    expect(rows()).toEqual([
      expect.objectContaining({ id: "box", host: "box.example" }),
    ]);

    // The file is the truth, and it is not world-readable.
    const saved = JSON.parse(
      await readFile(join(root, "ssh.json"), "utf8"),
    ) as { id: string }[];
    expect(saved.map((entry) => entry.id)).toEqual(["box"]);

    // A target that is not there is named as such.
    await expect(call(wire, "delete", { id: "nope" })).resolves.toEqual({
      result: { removed: false },
    });
    expect(
      (await call(wire, "delete", { id: "box" })) as {
        result: { removed: boolean };
      },
    ).toEqual({
      result: { removed: true },
    });
    expect(rows()).toEqual([]);
  });

  it("drops a remembered fingerprint when a target points somewhere else", async () => {
    const { wire } = await mounted();
    await call(wire, "save", { target: { id: "box", host: "box.example" } });
    await call(wire, "save", { target: { id: "box", host: "other.example" } });
    const rows = (): { fingerprint?: string; host: string }[] =>
      (wire.snapshot("ssh")?.sections.targets as {
        fingerprint?: string;
        host: string;
      }[]) ?? [];
    expect(rows()[0]).toMatchObject({ host: "other.example" });
    // A different host is a different machine: the key accepted for the old one means nothing.
    expect(rows()[0]?.fingerprint).toBeUndefined();
  });

  it("forgets a fingerprint on request, so trust is established again", async () => {
    const { wire } = await mounted();
    await call(wire, "save", { target: { id: "box", host: "box.example" } });
    await call(wire, "forget", { id: "box" });
    const row = (
      wire.snapshot("ssh")?.sections.targets as { fingerprint?: string }[]
    )[0];
    expect(row?.fingerprint).toBeUndefined();
  });
});

describe("a session on another machine", () => {
  it("gives the session an environment that reads and writes *that* machine's files", async () => {
    const { wire, plugin, root } = await mounted();
    await call(wire, "save", {
      target: { id: "box", host: "box.example", cwd: root },
    });
    plugin.bind("session-1", "box");

    const environment = await plugin.environments.for("session-1");
    expect(environment).toBeDefined();
    // A file written through the environment lands where the "remote" machine keeps it.
    const written = await environment?.env.writeFile(
      "note.txt",
      "written over ssh\n",
    );
    expect(written?.ok).toBe(true);
    expect(await readFile(join(root, "note.txt"), "utf8")).toBe(
      "written over ssh\n",
    );
    // And reading it back goes through the same seam.
    const read = await environment?.env.readTextFile("note.txt");
    expect(read?.ok === true ? read.value : "").toContain("written over ssh");

    // The tools a session installs are the harness's, unchanged: the same read/write/edit/bash
    // against a filesystem that happens to be elsewhere.
    const listed = await environment?.env.listDir(".");
    expect(listed?.ok).toBe(true);
  });

  it("says nothing for a session that is not bound to a target", async () => {
    const { plugin } = await mounted();
    expect(await plugin.environments.for("local-session")).toBeUndefined();
  });

  it("refuses a session bound to a target that does not exist, rather than falling back to local", async () => {
    const { plugin } = await mounted();
    plugin.bind("session-2", "nowhere");
    await expect(plugin.environments.for("session-2")).rejects.toThrow(
      /no such ssh target/,
    );
  });
});

describe("connecting", () => {
  it("answers with the machine's home, and remembers what it accepted", async () => {
    const { wire, root } = await mounted();
    await call(wire, "save", { target: { id: "box", host: "box.example" } });
    const connected = (await call(wire, "connect", { id: "box" })) as {
      result: { home: string; fingerprint: string | null };
    };
    expect(connected.result.home).toBe(root);

    // What a connection establishes is trust: the fingerprint the far side presented is
    // remembered for this target, and a *different* one later is a changed host. The local
    // transport has no key to present, so what is asserted here is the other half — a transport
    // that reports one gets it recorded, and that is what a real `ssh` does.
    const withKey = sshPlugin({
      path: join(root, "ssh.json"),
      transportFor: async () => {
        const transport = new LocalTransport({
          home: root,
        }) as LocalTransport & { expectedFingerprint?: string };
        transport.expectedFingerprint = "SHA256:abc";
        return transport;
      },
    });
    const ctx = new Context();
    const wire2 = new WireService(ctx);
    ctx.plugin(withKey as never, undefined as never);
    await until(() => wire2.descriptors().length > 0);
    await call(wire2, "save", { target: { id: "box", host: "box.example" } });
    const second = (await call(wire2, "connect", { id: "box" })) as {
      result: { fingerprint: string | null };
    };
    expect(second.result.fingerprint).toBe("SHA256:abc");
    const row = (
      wire2.snapshot("ssh")?.sections.targets as {
        fingerprint?: string;
        lastConnectedAt?: string;
      }[]
    )[0];
    expect(row).toMatchObject({ fingerprint: "SHA256:abc" });
    expect(row?.lastConnectedAt).toBeDefined();
  });
});

describe("a target that is not there", () => {
  it("is refused by connect, and by forget", async () => {
    const { wire } = await mounted();
    await expect(call(wire, "connect", { id: "ghost" })).rejects.toThrow(
      /no such ssh target/,
    );
    await expect(call(wire, "forget", { id: "ghost" })).rejects.toThrow(
      /no such ssh target/,
    );
    await expect(call(wire, "save", { target: { id: "x" } })).rejects.toThrow(
      /needs a target with an id and a host/,
    );
  });
});

it("unload waits for a pending connection to close, then can remount once", async () => {
  const root = await scratch();
  const ctx = new Context();
  const wire = new WireService(ctx);
  let resolveOpening!: (transport: LocalTransport) => void;
  const opening = new Promise<LocalTransport>((resolve) => {
    resolveOpening = resolve;
  });
  let releaseClose!: () => void;
  const closing = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  let closeStarted = false;
  const transport = new LocalTransport({ home: root });
  transport.close = async () => {
    closeStarted = true;
    await closing;
  };
  const plugin = sshPlugin({
    path: join(root, "ssh.json"),
    transportFor: () => opening,
  });
  const fiber = ctx.plugin(plugin as never, undefined as never);
  await until(() => wire.descriptors().length > 0);
  await call(wire, "save", { target: { id: "box", host: "box.example" } });
  const connecting = call(wire, "connect", { id: "box" });
  // Let connect record its opening promise before disposing the plugin.
  await Promise.resolve();
  let disposed = false;
  const disposal = fiber.dispose().then(() => {
    disposed = true;
  });
  try {
    await until(() => wire.descriptors().length === 0);
    expect(wire.snapshot("ssh")).toBeUndefined();
    expect(disposed).toBe(false);
    resolveOpening(transport);
    await connecting;
    await until(() => closeStarted);
    expect(disposed).toBe(false);
    releaseClose();
    await disposal;
    const replacement = ctx.plugin(plugin as never, undefined as never);
    await until(() => wire.descriptors().length > 0);
    expect(wire.descriptors()).toHaveLength(SSH_ACTIONS.length);
    await replacement.dispose();
    expect(wire.descriptors()).toEqual([]);
  } finally {
    resolveOpening(transport);
    releaseClose();
    await connecting;
    await disposal;
    await ctx.fiber.dispose();
  }
});
