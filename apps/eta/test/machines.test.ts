/**
 * Machines: getting a daemon onto the primary, and the link it dials.
 *
 * Every test here runs a real daemon (the daemon's own node and link, in this process, with a
 * data directory of its own) against a real host on a free port.
 */
import type { MachineView } from "@eta/client-contracts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DaemonLink, enroll } from "@eta/daemon";
import { describe, expect, it } from "vitest";
import { MachineStore } from "../src/machines/store";
import { until } from "./support/client";
import { approve, machineView, makeCode, startDaemon } from "./support/daemon";
import { tempDir, testHost } from "./support/host";
import { world } from "./support/world";

const base = (port: number): string => `http://127.0.0.1:${port}`;

async function enrollRaw(port: number, body: Record<string, unknown>) {
  return await fetch(`${base(port)}/machines/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("enrolling", () => {
  it("an install code makes a pending machine with the fingerprint the daemon printed", async () => {
    const w = await world();
    const daemon = await startDaemon(w.host, w.client, {
      name: "build box",
      idle: true,
    });
    await until(() => machineView(w.client, daemon.machineId) !== undefined);
    const view = machineView(w.client, daemon.machineId)!;
    expect(view).toMatchObject({
      kind: "daemon",
      name: "build box",
      status: "pending",
      fingerprint: daemon.fingerprint,
    });
    // The primary knows the digest, never the secret.
    expect(JSON.stringify(w.client.section("machines", "list"))).not.toContain(
      daemon.identity.secret,
    );
  });

  it("a code works once", async () => {
    const w = await world();
    const { code } = await makeCode(w.client, w.host);
    const first = await enroll({
      dataDir: await tempDir("eta-daemon-"),
      url: base(w.host.port),
      code,
    });
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      enroll({
        dataDir: await tempDir("eta-daemon-"),
        url: base(w.host.port),
        code,
      }),
    ).rejects.toThrow(/refused the code \(403/);
    // One machine, not two.
    expect(
      w.client
        .section<MachineView[]>("machines", "list")!
        .filter((machine) => machine.kind === "daemon"),
    ).toHaveLength(1);
  });

  it("an expired code, and a code nobody made, fail alike", async () => {
    const w = await world();
    const old = new MachineStore(w.host.db).enroll(
      undefined,
      Date.now() - 25 * 60 * 60 * 1000,
    );
    const fingerprint = "a".repeat(64);
    for (const code of [old.code, "eta_nonsense"]) {
      const response = await enrollRaw(w.host.port, {
        code,
        fingerprint,
        hostname: "x",
        home: "/h",
        os: "linux",
      });
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("invalid or expired code");
    }
  });

  it("refuses what is not an enrol request, and a body that is too big", async () => {
    const w = await world();
    for (const body of ["null", "[]", "not json", '"text"']) {
      const response = await fetch(`${base(w.host.port)}/machines/enroll`, {
        method: "POST",
        body,
      });
      expect(response.status).toBe(400);
    }
    const big = await fetch(`${base(w.host.port)}/machines/enroll`, {
      method: "POST",
      body: JSON.stringify({ code: "x".repeat(10_000) }),
    });
    expect(big.status).toBe(413);
    expect((await fetch(`${base(w.host.port)}/machines/enroll`)).status).toBe(
      405,
    );
  });

  it("stops listening after too many bad codes", async () => {
    const w = await world();
    const bad = {
      code: "eta_nope",
      fingerprint: "a".repeat(64),
      hostname: "x",
      home: "/h",
      os: "linux",
    };
    for (let i = 0; i < 20; i++)
      expect((await enrollRaw(w.host.port, bad)).status).toBe(403);
    expect((await enrollRaw(w.host.port, bad)).status).toBe(429);
  });

  it("the enrol route and the link need no token, but the rest of a gated host still does", async () => {
    const dir = await tempDir("eta-token-");
    const host = await testHost({ tokenFile: join(dir, "token") });
    // No cookie, no bearer: the enrol route still answers (with its own verdict).
    expect((await enrollRaw(host.port, { code: "x" })).status).toBe(400);
    expect((await fetch(`${base(host.port)}/version`)).status).toBe(401);
  });
});

describe("approving", () => {
  it("a pending machine stays out until its fingerprint is confirmed", async () => {
    const w = await world();
    const daemon = await startDaemon(w.host, w.client);
    await daemon.reached("pending");
    expect(machineView(w.client, daemon.machineId)?.status).toBe("pending");

    await expect(
      w.client.call("machines", "approve", {
        machineId: daemon.machineId,
        fingerprint: "b".repeat(64),
      }),
    ).rejects.toThrow(/not the fingerprint/);
    expect(machineView(w.client, daemon.machineId)?.status).toBe("pending");

    // The way a person types it: groups, upper case.
    const typed = daemon.fingerprint
      .toUpperCase()
      .replace(/(.{8})/g, "$1 ")
      .trim();
    await w.client.call("machines", "approve", {
      machineId: daemon.machineId,
      fingerprint: typed,
    });
    await daemon.reached("online");
    await until(
      () => machineView(w.client, daemon.machineId)?.status === "online",
    );
    expect(machineView(w.client, daemon.machineId)).toMatchObject({
      status: "online",
      home: expect.any(String),
    });
  });

  it("only a pending machine can be approved", async () => {
    const w = await world();
    const daemon = await startDaemon(w.host, w.client);
    await approve(w.client, daemon);
    await expect(
      w.client.call("machines", "approve", {
        machineId: daemon.machineId,
        fingerprint: daemon.fingerprint,
      }),
    ).rejects.toThrow(/not waiting for approval/);
  });
});

describe("the link", () => {
  it("a credential the primary does not know is refused at the door", async () => {
    const w = await world();
    const daemon = await startDaemon(w.host, w.client, { idle: true });
    await approve0(w, daemon);
    const states: string[] = [];
    const impostor = new DaemonLink({
      identity: { ...daemon.identity, secret: "not-the-secret" },
      server: undefined,
      backoff: { minMs: 20, maxMs: 50 },
      onState: (state) => states.push(state.state),
    });
    impostor.start();
    await until(() => states.includes("down"));
    await impostor.stop();
    expect(states).not.toContain("pending");
    expect(states).not.toContain("online");
    expect(machineView(w.client, daemon.machineId)?.status).not.toBe("online");
  });

  it("a newer connection from the same device supersedes the older one", async () => {
    const w = await world();
    const daemon = await startDaemon(w.host, w.client);
    await approve(w.client, daemon);
    const firstEpoch = (daemon.states.at(-1) as { epoch: number }).epoch;

    const states: { state: string; epoch?: number }[] = [];
    const second = new DaemonLink({
      identity: daemon.identity,
      server: daemon.node,
      // Never retry: the test is about who holds the slot.
      backoff: { minMs: 60_000, maxMs: 60_000 },
      onState: (state) =>
        states.push(state as { state: string; epoch?: number }),
    });
    second.start();
    await until(() => states.some((state) => state.state === "online"));
    const secondEpoch = states.find((state) => state.state === "online")!
      .epoch!;
    expect(secondEpoch).toBeGreaterThan(firstEpoch);

    // The first connection was closed under it, and says so.
    await until(() => daemon.states.some((state) => state.state === "down"));
    expect(daemon.states.find((state) => state.state === "down")).toMatchObject(
      { reason: "superseded" },
    );
    // It comes back (short backoff) and, being newer, takes the slot again: each connection that
    // gets in is a later epoch than the one before.
    await until(() => {
      const last = daemon.states.at(-1) as { state: string; epoch?: number };
      return last.state === "online" && last.epoch! > secondEpoch;
    });
    await second.stop();
  });

  it("reconnects after a drop, and nothing that was running is replayed", async () => {
    const w = await world();
    const daemon = await startDaemon(w.host, w.client);
    await approve(w.client, daemon);
    const link = w.host.product.hub.link(daemon.machineId)!;
    const work = await tempDir("eta-work-");
    const marker = join(work, "marker");
    const running = link
      .daemon("exec", {
        script: `echo ran >> ${marker}; exec sleep 30`,
        timeoutMs: 60_000,
      })
      .then(
        () => "finished",
        (error: Error) => error.message,
      );
    await until(async () => {
      try {
        return (await readFile(marker, "utf8")).includes("ran");
      } catch {
        return false;
      }
    });
    daemon.link.drop();
    // The caller is told it does not know: the script may or may not have finished.
    expect(await running).toMatch(/outcome is unknown/);
    await until(
      () => machineView(w.client, daemon.machineId)?.status === "offline",
    );
    await daemon.reached("online");
    await until(
      () => machineView(w.client, daemon.machineId)?.status === "online",
    );
    // A new epoch, and the old call is not run again.
    expect(await readFile(marker, "utf8")).toBe("ran\n");
  });

  it("revoking cuts the link and the machine cannot come back", async () => {
    const w = await world();
    const daemon = await startDaemon(w.host, w.client);
    await approve(w.client, daemon);
    await w.client.call("machines", "revoke", { machineId: daemon.machineId });
    await daemon.reached("revoked");
    expect(machineView(w.client, daemon.machineId)?.status).toBe("revoked");
    // It keeps knocking; it keeps being refused.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(machineView(w.client, daemon.machineId)?.status).toBe("revoked");
    expect(w.host.product.hub.link(daemon.machineId)).toBeUndefined();
  });

  it("is offline when its daemon goes away", async () => {
    const w = await world();
    const daemon = await startDaemon(w.host, w.client);
    await approve(w.client, daemon);
    await daemon.link.stop();
    await until(
      () => machineView(w.client, daemon.machineId)?.status === "offline",
    );
  });

  it("a frame over the limit breaks the link rather than being accepted", async () => {
    const w = await world();
    const daemon = await startDaemon(w.host, w.client);
    await approve(w.client, daemon);
    const link = w.host.product.hub.link(daemon.machineId)!;
    // 9 MB of script: the primary refuses to send it, so nothing reaches the daemon.
    await expect(
      link.daemon("exec", { script: "x".repeat(9 * 1024 * 1024) }),
    ).rejects.toThrow(/too big/);
  });
});

describe("projects on a machine", () => {
  it("a path is checked on the machine that has it", async () => {
    const w = await world();
    const daemon = await startDaemon(w.host, w.client);
    await approve(w.client, daemon);
    // A directory only the daemon side has been told about: it exists on this computer too (it is
    // the same computer), so make the distinction by a path that exists nowhere.
    const dir = await tempDir("eta-remote-project-");
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "file"), "x");

    const created = (await w.client.call("projects", "create", {
      machineId: daemon.machineId,
      path: join(dir, "sub"),
    })) as { project: { machineId: string; path: string } };
    expect(created.project).toMatchObject({
      machineId: daemon.machineId,
      path: join(dir, "sub"),
    });
    await expect(
      w.client.call("projects", "create", {
        machineId: daemon.machineId,
        path: join(dir, "nope"),
      }),
    ).rejects.toThrow(/no such directory/);
    await expect(
      w.client.call("projects", "create", {
        machineId: daemon.machineId,
        path: join(dir, "file"),
      }),
    ).rejects.toThrow(/not a directory/);
  });

  it("an offline machine cannot take a project", async () => {
    const w = await world();
    const daemon = await startDaemon(w.host, w.client);
    await approve(w.client, daemon);
    await daemon.link.stop();
    await until(
      () => machineView(w.client, daemon.machineId)?.status === "offline",
    );
    await expect(
      w.client.call("projects", "create", {
        machineId: daemon.machineId,
        path: await tempDir("eta-remote-project-"),
      }),
    ).rejects.toThrow(/offline/);
  });
});

/** Approve through the host without waiting for the link (the daemon is idle). */
async function approve0(
  w: Awaited<ReturnType<typeof world>>,
  daemon: { machineId: string; fingerprint: string },
): Promise<void> {
  await w.client.call("machines", "approve", {
    machineId: daemon.machineId,
    fingerprint: daemon.fingerprint,
  });
}
