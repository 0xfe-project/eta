/**
 * Machines: getting a daemon onto the primary, and the link it dials.
 *
 * Every test here runs a real daemon (the daemon's own node and link, in this process, with a
 * data directory of its own) against a real host on a free port.
 */
import type {
  AgentView,
  ConversationSummary,
  MachineRemovePreview,
  MachineRemoveResult,
  MachineView,
  ProjectView,
} from "@eta/client-contracts";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LINK_LIMITS } from "@eta/client-contracts";
import { TARGET_MISSING } from "@eta/client-wire-proto";
import { DaemonLink, enroll } from "@eta/daemon";
import { describe, expect, it } from "vitest";
import { MachineStore } from "../src/machines/store";
import { TaskRunStore } from "../src/tasks/runs";
import { connect, until } from "./support/client";
import {
  approve,
  dropLink,
  machineView,
  makeCode,
  startDaemon,
} from "./support/daemon";
import { tempDir, testHost } from "./support/host";
import { HANG, scriptedModels } from "./support/models";
import { world } from "./support/world";

const base = (port: number): string => `http://127.0.0.1:${port}`;

async function enrollRaw(port: number, body: Record<string, unknown>) {
  return await fetch(`${base(port)}/machines/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("the phone's link", () => {
  it("carries the address asked for and the token", async () => {
    const dir = await tempDir();
    const tokenFile = join(dir, "token");
    await writeFile(tokenFile, "a-token-of-sixteen-or-more\n");
    const host = await testHost({ tokenFile });
    const client = await connect(`ws://127.0.0.1:${host.port}/ws`, {
      "x-eta-token": "a-token-of-sixteen-or-more",
    });
    await client.hello();
    const result = await client.call("machines", "phoneLink", {
      url: "https://eta.example.com/settings",
    });
    const link = new URL((result as { link: string }).link);
    expect(link.protocol).toBe("eta:");
    expect(link.searchParams.get("address")).toBe("https://eta.example.com");
    expect(link.searchParams.get("token")).toBe("a-token-of-sixteen-or-more");
  });
});

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

  it.skipIf(process.platform === "win32")(
    "reconnects after a drop, and nothing that was running is replayed",
    async () => {
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
      await dropLink(w.host, w.client, daemon);
      // The caller is told it does not know: the script may or may not have finished.
      expect(await running).toMatch(/outcome is unknown/);
      // A new epoch, and the old call is not run again.
      expect(await readFile(marker, "utf8")).toBe("ran\n");
    },
  );

  it("removing an online machine cuts the link with 4003, refuses 401 reconnects, and cleans up all dependents", async () => {
    const { models, requests } = scriptedModels(() => HANG);
    const w = await world({ models });
    const daemon = await startDaemon(w.host, w.client, { name: "gpu-box" });
    await approve(w.client, daemon);

    const primaryId = w.client
      .section<MachineView[]>("machines", "list")!
      .find((m) => m.kind === "primary")!.id;

    // Refuses removing primary machine or unknown machine.
    await expect(
      w.client.call("machines", "removePreview", { machineId: primaryId }),
    ).rejects.toThrow(/not a daemon machine/);
    await expect(
      w.client.call("machines", "remove", { machineId: primaryId }),
    ).rejects.toThrow(/not a daemon machine/);
    await expect(
      w.client.call("machines", "remove", { machineId: "no-such-machine" }),
    ).rejects.toThrow(/no such machine/);

    // Create pinned external agent, pinned built-in eta agent, and an unpinned eta agent.
    const extAgent = await w.agent("ExtClaude", {
      runtime: "claude",
      machineId: daemon.machineId,
    });
    const etaPinned = await w.agent("PinnedEta", {
      machineId: daemon.machineId,
    });
    const etaFree = await w.agent("FreeEta");

    // Project and two conversations (one active, one archived) on the daemon.
    const projDir = await tempDir("eta-remove-proj-");
    const project = await w.project({
      machineId: daemon.machineId,
      path: projDir,
      name: "remote-repo",
    });
    const conv = await w.group(
      project.id,
      [etaPinned.id, etaFree.id],
      "remote-chat",
    );
    const archivedConv = await w.group(
      project.id,
      [etaFree.id],
      "archived-chat",
    );
    await w.client.call("conversations", "update", {
      conversationId: archivedConv.id,
      archived: true,
    });
    await w.watch(conv.id);

    // Upload an attachment into conv so its attachments/<convId> directory exists on disk.
    await w.client.call("conversations", "attach", {
      conversationId: conv.id,
      uploadId: crypto.randomUUID(),
      name: "note.txt",
      contentType: "text/plain",
      index: 0,
      last: true,
      data: Buffer.from("hello").toString("base64"),
    });
    const attachDir = join(w.host.dataDir, "attachments", conv.id);
    expect(existsSync(attachDir)).toBe(true);

    // Project creation already records place_recent; also seed place_clone_parent for the daemon.
    expect(
      w.host.db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM place_recent WHERE machine_id = ?",
        )
        .get(daemon.machineId)!.n,
    ).toBeGreaterThan(0);
    w.host.db
      .query(
        "INSERT INTO place_clone_parent (machine_id, path, updated_at) VALUES (?, ?, ?)",
      )
      .run(daemon.machineId, projDir, Date.now());

    // Start an active reply on the pinned eta agent (running on the daemon).
    const sent = await w.send(conv.id, "say hi", { mentions: [etaPinned.id] });
    await until(() => requests.length >= 1);
    await w.settled(conv.id, sent.replies[0]!.id, ["working"]);

    // Create a task on the remote project assigned to etaPinned so an open task_run exists,
    // plus an artifact attached to the task and conversation.
    const task = w.host.product.board.create(
      {
        title: "Remote job",
        description: "Run on gpu-box",
        status: "todo",
        conversationId: conv.id,
        workspace: "local",
      },
      { kind: "agent", agentId: etaPinned.id },
    );
    const runs = new TaskRunStore(w.host.db);
    await until(() =>
      runs
        .openOf(task.id)
        .some((r) => r.status === "starting" || r.status === "running"),
    );
    w.host.db
      .query(
        `INSERT INTO artifact (id, title, publisher_agent, task_id, conversation_id, created_at, updated_at)
         VALUES ('art-hist', 'Build report', ?, ?, ?, ?, ?)`,
      )
      .run(etaPinned.id, task.id, conv.id, Date.now(), Date.now());

    // Preview reports everything accurately.
    const preview = (await w.client.call("machines", "removePreview", {
      machineId: daemon.machineId,
    })) as MachineRemovePreview;
    expect(preview.machine).toEqual({
      id: daemon.machineId,
      name: "gpu-box",
    });
    expect(preview.agents).toEqual(
      expect.arrayContaining([
        { id: extAgent.id, name: "ExtClaude", runtime: "claude" },
        { id: etaPinned.id, name: "PinnedEta", runtime: "eta" },
      ]),
    );
    expect(preview.agents).toHaveLength(2);
    expect(preview.projects).toEqual([
      { id: project.id, name: "remote-repo", path: projDir },
    ]);
    expect(preview.conversations).toEqual(
      expect.arrayContaining([
        {
          id: conv.id,
          name: "remote-chat",
          projectId: project.id,
          archived: false,
        },
        {
          id: archivedConv.id,
          name: "archived-chat",
          projectId: project.id,
          archived: true,
        },
      ]),
    );
    expect(preview.activeRuns).toBeGreaterThanOrEqual(1);
    expect(preview.activeReplies).toBeGreaterThanOrEqual(1);

    // Execute removal.
    const removed = (await w.client.call("machines", "remove", {
      machineId: daemon.machineId,
    })) as MachineRemoveResult;
    expect(removed.machineId).toBe(daemon.machineId);
    expect(removed.removedAgents).toEqual(
      expect.arrayContaining([extAgent.id, etaPinned.id]),
    );
    expect(removed.removedProjects).toEqual([project.id]);
    expect(removed.removedConversations).toEqual(
      expect.arrayContaining([conv.id, archivedConv.id]),
    );

    // Daemon received 4003 (revoked close code -> client enters "revoked" backoff state).
    await daemon.reached("revoked");
    expect(w.host.product.hub.link(daemon.machineId)).toBeUndefined();

    // Machine row is gone and subsequent reconnect attempts fail with 401.
    await until(() => machineView(w.client, daemon.machineId) === undefined);
    const reconnect = await fetch(`${base(w.host.port)}/machines/connect`, {
      headers: {
        authorization: `Bearer ${daemon.identity.machineId}.${daemon.identity.secret}`,
      },
    });
    expect(reconnect.status).toBe(401);

    // Both pinned agents deleted (and their agent_home projects archived); unpinned agent remains.
    await until(
      () =>
        w.client
          .section<AgentView[]>("agents", "list")
          ?.every((a) => a.id !== extAgent.id && a.id !== etaPinned.id) ===
        true,
    );
    const remainingAgents = w.client.section<AgentView[]>("agents", "list")!;
    expect(remainingAgents.some((a) => a.id === etaFree.id)).toBe(true);

    const projects = w.client.section<ProjectView[]>("projects", "list")!;
    expect(projects.some((p) => p.id === project.id)).toBe(false);
    expect(
      projects.find((p) => p.id === extAgent.homeProjectId)?.archived,
    ).toBe(true);
    expect(
      projects.find((p) => p.id === etaPinned.homeProjectId)?.archived,
    ).toBe(true);

    // Conversations and attachment directories are gone.
    const conversations = w.client.section<ConversationSummary[]>(
      "conversations",
      "list",
    )!;
    expect(
      conversations.some((c) => c.id === conv.id || c.id === archivedConv.id),
    ).toBe(false);
    expect(existsSync(attachDir)).toBe(false);

    // Place records are gone.
    expect(
      w.host.db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM place_recent WHERE machine_id = ?",
        )
        .get(daemon.machineId)!.n,
    ).toBe(0);

    // Open task runs were failed synchronously.
    await until(() => runs.openOf(task.id).length === 0);
    const [failedRun] = runs.ofTask(task.id);
    expect(failedRun).toMatchObject({
      status: "failed",
      error: "Machine gpu-box was removed.",
    });

    // Historical task and artifact are preserved with NULL references.
    expect(
      w.host.db
        .query<
          {
            project_id: string | null;
            conversation_id: string | null;
            origin_conversation_id: string | null;
          },
          [string]
        >(
          "SELECT project_id, conversation_id, origin_conversation_id FROM task WHERE id = ?",
        )
        .get(task.id),
    ).toEqual({
      project_id: null,
      conversation_id: null,
      origin_conversation_id: null,
    });
    expect(
      w.host.db
        .query<{ conversation_id: string | null }, []>(
          "SELECT conversation_id FROM artifact WHERE id = 'art-hist'",
        )
        .get(),
    ).toEqual({ conversation_id: null });

    // Conversation wire target was unregistered (subscribing from a fresh client gets an error).
    const probe = await connect(`ws://127.0.0.1:${w.host.port}/ws`);
    await probe.hello();
    probe.subscribe(`conversations.${conv.id}`);
    await until(() =>
      probe.frames.some(
        (frame) =>
          frame.type === "event" &&
          frame.target === `conversations.${conv.id}` &&
          frame.name === TARGET_MISSING,
      ),
    );
    probe.close();
  });

  it("removes offline and pending daemon machines and fails orphaned queued runs", async () => {
    const w = await world();
    // 1. Offline daemon with a queued run.
    const offlineDaemon = await startDaemon(w.host, w.client, {
      name: "offline-box",
    });
    await approve(w.client, offlineDaemon);
    const agent = await w.agent("OfflineClaude", {
      runtime: "claude",
      machineId: offlineDaemon.machineId,
    });
    const project = await w.project({
      machineId: offlineDaemon.machineId,
      path: await tempDir("eta-off-"),
      name: "off-proj",
    });
    const conv = await w.group(project.id, [agent.id], "off-chat");
    await offlineDaemon.stop();
    await until(
      () =>
        machineView(w.client, offlineDaemon.machineId)?.status === "offline",
    );
    const task = w.host.product.board.create(
      {
        title: "Queued on offline",
        description: "Wait",
        status: "todo",
        conversationId: conv.id,
        workspace: "local",
      },
      { kind: "agent", agentId: agent.id },
    );
    const runs = new TaskRunStore(w.host.db);
    await until(
      () => runs.openOf(task.id)[0]?.queueReason === "machine_offline",
    );

    await w.client.call("machines", "remove", {
      machineId: offlineDaemon.machineId,
    });
    await until(
      () => machineView(w.client, offlineDaemon.machineId) === undefined,
    );
    expect(runs.openOf(task.id)).toEqual([]);
    expect(runs.ofTask(task.id)[0]).toMatchObject({
      status: "failed",
      error: "Machine offline-box was removed.",
    });

    // 2. Pending daemon removal.
    const pendingDaemon = await startDaemon(w.host, w.client, {
      name: "pending-box",
    });
    await pendingDaemon.reached("pending");
    await w.client.call("machines", "remove", {
      machineId: pendingDaemon.machineId,
    });
    await until(
      () => machineView(w.client, pendingDaemon.machineId) === undefined,
    );

    // 3. TaskRunner.#pass() fails a queued run whose machine id does not exist rather than
    // looping machine_offline forever.
    const primaryAgent = await w.agent("PrimaryWorker");
    const primaryProj = await w.project();
    const primaryGroup = await w.group(primaryProj.id, [primaryAgent.id]);
    const orphanTask = w.host.product.board.create(
      {
        title: "Orphaned machine run",
        description: "Check guard",
        status: "backlog",
        conversationId: primaryGroup.id,
        workspace: "local",
      },
      { kind: "agent", agentId: primaryAgent.id },
    );
    const orphanRun = runs.create(orphanTask.id, "missing-machine-id");
    const primaryId = w.client
      .section<MachineView[]>("machines", "list")!
      .find((m) => m.kind === "primary")!.id;
    await w.client.call("machines", "setMaxActiveRuns", {
      machineId: primaryId,
      maxActiveRuns: 3,
    });
    expect(runs.get(orphanRun.id)).toMatchObject({
      status: "failed",
      error: "The machine for this run was removed.",
    });
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

  it("a message over maxMessageBytes is refused before it is sent", async () => {
    const w = await world();
    const daemon = await startDaemon(w.host, w.client);
    await approve(w.client, daemon);
    const link = w.host.product.hub.link(daemon.machineId)!;
    expect(link.peer.chunked).toBe(true);
    // Over maxMessageBytes: the primary refuses to send it, so nothing reaches the daemon.
    await expect(
      link.daemon("exec", {
        script: "x".repeat(LINK_LIMITS.maxMessageBytes + 1024),
      }),
    ).rejects.toThrow(/too big/);
  });

  it("does not chunk outbound frames to a legacy daemon that did not advertise chunking", async () => {
    const w = await world();
    const daemon = await startDaemon(w.host, w.client, { idle: true });
    const node = daemon.node;
    const attach = node.attach.bind(node);
    node.attach = (peer) => {
      const inner = attach(peer);
      return {
        close: inner.close,
        receive(frame: unknown) {
          const call = frame as {
            op?: unknown;
            target?: unknown;
            action?: unknown;
            requestId?: unknown;
          };
          if (
            call.op === "call" &&
            call.target === "machine" &&
            call.action === "info" &&
            typeof call.requestId === "string"
          ) {
            peer.sendPipe({
              type: "reply",
              requestId: call.requestId,
              ok: true,
              result: {
                hostname: "legacy",
                home: daemon.dataDir,
                os: "linux",
                version: "test",
                protocol: 1,
              },
            });
            return;
          }
          inner.receive(frame);
        },
      };
    };
    daemon.link.start();
    await approve(w.client, daemon);
    const link = w.host.product.hub.link(daemon.machineId)!;
    expect(link.peer.chunked).toBe(false);
    await expect(
      link.daemon("exec", { script: "x".repeat(9 * 1024 * 1024) }),
    ).rejects.toThrow(/too big/);
  });

  it("tells a daemon from before GitHub went that GitHub is not connected", async () => {
    const w = await world();
    const daemon = await startDaemon(w.host, w.client, { idle: true });
    const node = daemon.node;
    const attach = node.attach.bind(node);
    let peer: Parameters<typeof attach>[0] | undefined;
    node.attach = (to) => {
      peer = to;
      return attach(to);
    };
    daemon.link.start();
    await approve(w.client, daemon);
    // Such a daemon asks every minute until it is upgraded; an error would be a warning each time.
    expect(await peer!.call("github.credentials", {})).toBeNull();
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
