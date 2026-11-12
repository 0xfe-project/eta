/**
 * Captain proposes a group; the user's confirmation makes it.
 *
 * The tool is Captain's alone, including in a session an older build opened. A proposal makes
 * nothing, not even a project: it is a pending `create_group` operation and a card in the
 * conversation it came from. Confirming makes the project (for a directory that is not one yet) and
 * the group; rejecting makes nothing. Either way Captain is told in that conversation and carries on.
 * A group of the same name in the same project stops it at both points.
 */
import type {
  CaptainGroupProposalRowData,
  CaptainOperationView,
} from "@eta/client-contracts";
import type { GroupProposalInput } from "../src/captain/service";
import type { Request } from "./support/models";
import type { World } from "./support/world";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentHome } from "../src/agents/store";
import { GroupConflictError } from "../src/captain/service";
import { until } from "./support/client";
import { approve, startDaemon } from "./support/daemon";
import { tempDir } from "./support/host";
import { call, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

const options = { captain: true, tasks: { runs: false } } as const;

function counts(w: World): { projects: number; conversations: number } {
  const one = (sql: string) => w.host.db.query<{ n: number }, []>(sql).get()!.n;
  return {
    projects: one("SELECT COUNT(*) AS n FROM project"),
    conversations: one("SELECT COUNT(*) AS n FROM conversation"),
  };
}

const one = <T>(w: World, sql: string, id: string): T | undefined =>
  w.host.db.query<T, [string]>(sql).get(id) ?? undefined;

const projectRow = (w: World, id: string) =>
  one<{ machineId: string; path: string; name: string; stewardId: string }>(
    w,
    `SELECT machine_id AS machineId, path, name, steward_id AS stewardId
       FROM project WHERE id = ?`,
    id,
  );

const decide = async (w: World, operationId: string, decision: string) =>
  (
    (await w.client.call("captain", "decideOperation", {
      operationId,
      decision,
    })) as { operation: CaptainOperationView }
  ).operation;

/** A host with Captain and Ada, and Captain's proposals made directly through the service. */
async function setup(models?: ReturnType<typeof scriptedModels>["models"]) {
  const w = await world({ ...options, ...(models ? { models } : {}) });
  const ada = await w.agent("Ada");
  const { conversationId: captain } = await w.host.product.captain.direct();
  await w.watch(captain);
  const captainId = w.host.product.captain.identity()!.agentId;
  const propose = (fields: Partial<GroupProposalInput>) =>
    w.host.product.captain.proposeGroup({
      name: "Clone",
      memberIds: [ada.id],
      stewardId: ada.id,
      ...fields,
      originConversationId: captain,
      captainAgentId: captainId,
    });
  return { w, ada, captain, captainId, propose };
}

/**
 * Captain's side of the conversation, scripted: it proposes what `proposal()` says when the user
 * asks, and when it is told the group exists, assigns work in it.
 */
function captainScript(proposal: () => Record<string, unknown>) {
  const told: string[] = [];
  const { models, requests } = scriptedModels((request: Request) => {
    if (request.agent !== "Captain") return say("On it.");
    if (request.lastRole === "toolResult")
      return say(
        request.last.includes("Captain assignment") ? "Assigned." : "Proposed.",
      );
    if (request.last.includes("Your proposed group")) {
      told.push(request.last);
      const created = /conversationId: (\S+)/.exec(request.last)?.[1];
      return created === undefined
        ? say("Understood.")
        : call("assign_in_group", {
            conversationId: created,
            text: "Please start on the repository.",
          });
    }
    if (request.last.includes("make a group"))
      return call("propose_group", proposal());
    return say("Captain ready.");
  });
  return { models, requests, told };
}

/** The proposal card Captain's tool call left in its conversation. */
const cardOf = (w: World, conversationId: string) =>
  w
    .rows(conversationId)
    .find(
      (row) =>
        (row.data as { event?: string }).event === "captain_group_proposal",
    )?.data as unknown as CaptainGroupProposalRowData | undefined;

describe("propose_group is Captain's", () => {
  it("is offered to Captain's session and to no other agent's", async () => {
    const { models, requests } = scriptedModels(() => say("Hello."));
    const { w, ada, captain } = await setup(models);
    const project = await w.project({ stewardId: ada.id });
    const group = await w.group(project.id, [ada.id]);
    await w.watch(group.id);
    for (const id of [group.id, captain]) {
      const sent = await w.send(id, "Hi");
      await w.settled(id, sent.replies[0]!.id);
    }
    const tools = (agent: string) =>
      requests.find((request) => request.agent === agent)!.tools;
    expect(tools("Captain")).toContain("propose_group");
    expect(tools("Ada")).not.toContain("propose_group");
  });

  it("reaches a Captain session that an older build opened and pinned", async () => {
    const dataDir = await tempDir();
    const sessionOf = (w: World, captain: string) =>
      one<{ id: string }>(
        w,
        "SELECT session_id AS id FROM participant WHERE conversation_id = ?",
        captain,
      )!.id;
    const before = await world({ ...options, dataDir });
    const { conversationId: captain } =
      await before.host.product.captain.direct();
    await before.watch(captain);
    const sent = await before.send(captain, "Hi");
    await before.settled(captain, sent.replies[0]!.id);
    const sessionId = sessionOf(before, captain);
    // What a build without the tool left in the journal: a pin that does not name it.
    const managed = (await before.host.server.sessions.session(sessionId))!;
    const pinned = managed.session.kernel.config.read("activeToolNames");
    expect(pinned).toContain("propose_group");
    managed.session.kernel.config.update({
      activeToolNames: pinned.filter((name) => name !== "propose_group"),
    });
    await before.host.close();

    const { models, requests } = scriptedModels(() => say("Hello again."));
    const after = await world({ ...options, models, dataDir });
    await after.watch(captain);
    const again = await after.send(captain, "Still there?");
    await after.settled(captain, again.replies[0]!.id);
    expect(sessionOf(after, captain)).toBe(sessionId);
    expect(requests.at(-1)!.tools).toContain("propose_group");
  });
});

describe("a group Captain proposes", () => {
  it("is only a card until the user creates it; then Captain assigns work in it", async () => {
    let proposal: Record<string, unknown> = {};
    const script = captainScript(() => proposal);
    const { w, ada, captain } = await setup(script.models);
    const bola = await w.agent("Bola");
    const project = await w.project({ stewardId: ada.id, name: "Repo" });
    proposal = {
      name: "Launch",
      projectId: project.id,
      memberIds: [ada.id, bola.id],
      stewardId: bola.id,
      goal: "Ship the launch page",
    };
    const start = counts(w);
    const asked = await w.send(captain, "Please make a group for the launch.");
    await w.settled(captain, asked.replies[0]!.id);
    expect(counts(w)).toEqual(start);
    const card = cardOf(w, captain)!;
    expect(card.proposal).toMatchObject({
      name: "Launch",
      projectId: project.id,
      projectName: "Repo",
      originConversationId: captain,
    });
    // The card and the Captain panel's list are the same record.
    expect(
      w.host.product.captain.store.operation(card.operationId),
    ).toMatchObject({ kind: "create_group", status: "pending" });

    const decided = await decide(w, card.operationId, "approve");
    expect(decided.status).toBe("applied");
    const groupId = (decided.result as { conversationId: string })
      .conversationId;
    expect(
      one(
        w,
        "SELECT name, project_id, steward_id, goal FROM conversation WHERE id = ?",
        groupId,
      ),
    ).toEqual({
      name: "Launch",
      project_id: project.id,
      steward_id: bola.id,
      goal: "Ship the launch page",
    });
    expect(
      w.host.db
        .query<{ agent_id: string }, [string]>(
          "SELECT agent_id FROM participant WHERE conversation_id = ? ORDER BY agent_id",
        )
        .all(groupId)
        .map((row) => row.agent_id),
    ).toEqual([ada.id, bola.id].sort());
    expect(counts(w)).toEqual({
      ...start,
      conversations: start.conversations + 1,
    });
    await w.watch(groupId);
    expect(w.rows(groupId)[0]).toMatchObject({
      kind: "system",
      seq: 1,
      data: { event: "captain_created" },
    });

    // Captain hears it in the same conversation and goes on with assign_in_group.
    await until(() =>
      w.rows(groupId).some((message) => message.author === "captain"),
    );
    expect(script.told[0]).toContain(`conversationId: ${groupId}`);
  });

  it("makes nothing when rejected, and Captain is told", async () => {
    let proposal: Record<string, unknown> = {};
    const script = captainScript(() => proposal);
    const { w, ada, captain } = await setup(script.models);
    const project = await w.project({ stewardId: ada.id });
    proposal = {
      name: "Docs",
      projectId: project.id,
      memberIds: [ada.id],
      stewardId: ada.id,
    };
    const asked = await w.send(captain, "Please make a group for docs.");
    await w.settled(captain, asked.replies[0]!.id);
    const start = counts(w);
    const { operationId } = cardOf(w, captain)!;
    expect((await decide(w, operationId, "reject")).status).toBe("rejected");
    expect(counts(w)).toEqual(start);
    await until(() => script.told.length === 1);
    expect(script.told[0]).toContain("rejected");
    await expect(decide(w, operationId, "approve")).rejects.toThrow(/rejected/);
  });
});

describe("a group of the same name", () => {
  it("stops the proposal, with the group that is there", async () => {
    let proposal: Record<string, unknown> = {};
    const script = captainScript(() => proposal);
    const { w, ada, captain, propose } = await setup(script.models);
    const project = await w.project({ stewardId: ada.id });
    const existing = await w.group(project.id, [ada.id], "Launch");
    proposal = {
      name: " Launch ",
      projectId: project.id,
      memberIds: [ada.id],
      stewardId: ada.id,
    };
    const asked = await w.send(captain, "Please make a group.");
    await w.settled(captain, asked.replies[0]!.id);
    expect(w.host.product.captain.store.operations()).toEqual([]);
    expect(cardOf(w, captain)).toBeUndefined();
    const result = script.requests.find(
      (request) =>
        request.agent === "Captain" && request.lastRole === "toolResult",
    )!;
    expect(result.last).toContain("Conflict");
    expect(result.last).toContain(existing.id);
    await expect(
      propose({ name: "Launch", projectId: project.id }),
    ).rejects.toBeInstanceOf(GroupConflictError);

    // An archived group of that name is not in the way.
    await w.client.call("conversations", "update", {
      conversationId: existing.id,
      archived: true,
    });
    await expect(
      propose({ name: "Launch", projectId: project.id }),
    ).resolves.toBeDefined();
  });

  it("stops the confirmation when one appeared in the meantime", async () => {
    const { w, ada, propose } = await setup();
    const project = await w.project({ stewardId: ada.id });
    const { operation } = await propose({
      name: "Launch",
      projectId: project.id,
    });
    const meanwhile = await w.group(project.id, [ada.id], "Launch");
    const start = counts(w);
    const decided = await decide(w, operation.id, "approve");
    expect(decided).toMatchObject({ status: "failed" });
    expect(decided.error).toContain(meanwhile.id);
    expect(counts(w)).toEqual(start);
  });

  it("counts for a new directory once that directory has become a project", async () => {
    const { w, ada, propose } = await setup();
    const dir = await tempDir("eta-clone-");
    const { operation } = await propose({ name: "Launch", path: dir });
    expect(operation.payload).toMatchObject({ projectId: null, path: dir });
    // The user added the directory and made a group of that name before confirming.
    const project = await w.project({ path: dir });
    await w.group(project.id, [ada.id], "Launch");
    const decided = await decide(w, operation.id, "approve");
    expect(decided.status).toBe("failed");
    expect(decided.error).toMatch(/already exists/);
  });
});

describe("what a proposal is refused for", () => {
  it("refuses directories that are missing, files, workspaces or archived", async () => {
    const { w, ada, captainId, propose } = await setup();
    const root = await tempDir("eta-paths-");
    await writeFile(join(root, "notes.txt"), "x");
    const archived = await w.project({ path: await tempDir("eta-old-") });
    await w.client.call("projects", "update", {
      projectId: archived.id,
      archived: true,
    });
    const adaHome = one<{ id: string }>(
      w,
      "SELECT id FROM project WHERE kind = 'agent_home' AND steward_id = ?",
      ada.id,
    )!;
    const start = counts(w);
    const refused: [Partial<GroupProposalInput>, RegExp][] = [
      [{ path: join(root, "missing") }, /no such directory/],
      [{ path: join(root, "notes.txt") }, /not a directory/],
      [{ path: "relative/dir" }, /absolute/],
      [{ path: agentHome(w.host.dataDir, ada.id) }, /agent's own workspace/],
      [{ path: agentHome(w.host.dataDir, captainId) }, /agent's own workspace/],
      [{ projectId: adaHome.id }, /agent's own workspace/],
      [{ projectId: archived.id }, /archived/],
      [{ path: archived.path }, /archived/],
      [{ path: root, projectId: archived.id }, /either projectId or path/],
    ];
    for (const [fields, reason] of refused)
      await expect(propose(fields), JSON.stringify(fields)).rejects.toThrow(
        reason,
      );
    expect(counts(w)).toEqual(start);
    expect(w.host.product.captain.store.operations()).toEqual([]);
  });

  it("refuses members that are none, Captain, gone, or without the steward", async () => {
    const { w, ada, captainId, propose } = await setup();
    const bola = await w.agent("Bola");
    const projectId = (await w.project()).id;
    const refused: [Partial<GroupProposalInput>, RegExp][] = [
      [{ memberIds: [] }, /at least one member/],
      [{ memberIds: [ada.id, captainId] }, /Captain cannot be a member/],
      [{ stewardId: bola.id }, /steward has to be a member/],
      [{ memberIds: ["nobody"], stewardId: "nobody" }, /does not exist/],
      [{ name: "  " }, /needs a name/],
    ];
    for (const [fields, reason] of refused)
      await expect(
        propose({ projectId, ...fields }),
        JSON.stringify(fields),
      ).rejects.toThrow(reason);
  });
});

describe("a new directory", () => {
  it("becomes a project stewarded by the group's steward when the user creates the group", async () => {
    const { w, ada, propose } = await setup();
    const dir = join(await tempDir("eta-captain-"), "small-repo");
    await mkdir(dir);
    const start = counts(w);
    const { operation } = await propose({ path: `${dir}/` });
    expect(operation.payload).toMatchObject({
      projectId: null,
      path: dir,
      projectName: "small-repo",
    });
    expect(counts(w)).toEqual(start);
    const decided = await decide(w, operation.id, "approve");
    const result = decided.result as {
      conversationId: string;
      projectId: string;
      projectCreated: boolean;
    };
    expect(result.projectCreated).toBe(true);
    expect(projectRow(w, result.projectId)).toMatchObject({
      path: dir,
      name: "small-repo",
      stewardId: ada.id,
      machineId: w.host.db
        .query<{ id: string }, []>(
          "SELECT id FROM machine WHERE kind = 'primary'",
        )
        .get()!.id,
    });
    // The steward is the project's, followed rather than copied, as the dialog makes it.
    expect(
      one(
        w,
        "SELECT steward_id, project_id FROM conversation WHERE id = ?",
        result.conversationId,
      ),
    ).toEqual({ steward_id: null, project_id: result.projectId });
  });

  it("fails at confirmation when the directory went away or a member was deleted", async () => {
    for (const change of ["directory", "member"] as const) {
      const { w, ada, propose } = await setup();
      const dir = join(await tempDir("eta-captain-"), "gone");
      await mkdir(dir);
      const { operation } = await propose({ path: dir });
      if (change === "directory") await rm(dir, { recursive: true });
      else await w.client.call("agents", "delete", { agentId: ada.id });
      const start = counts(w);
      const decided = await decide(w, operation.id, "approve");
      expect(decided.status).toBe("failed");
      expect(decided.error).toMatch(
        change === "directory" ? /no such directory/ : /does not exist/,
      );
      expect(counts(w)).toEqual(start);
    }
  });

  it("is checked on the machine it is on", async () => {
    const { w, ada, propose } = await setup();
    const daemon = await startDaemon(w.host, w.client, { name: "gpu-box" });
    await approve(w.client, daemon);
    const machineId = daemon.machineId;
    const there = join(daemon.dataDir, "checkout");
    await mkdir(there);
    await expect(
      propose({ path: join(daemon.dataDir, "nowhere"), machineId }),
    ).rejects.toThrow(/no such directory/);
    await expect(
      propose({ path: there, machineId: "no-such" }),
    ).rejects.toThrow(/no such machine/);
    const { operation } = await propose({ path: there, machineId });
    const decided = await decide(w, operation.id, "approve");
    expect(
      projectRow(w, (decided.result as { projectId: string }).projectId),
    ).toMatchObject({ machineId, path: there, stewardId: ada.id });

    // Offline, the machine cannot say, so the proposal is refused.
    await daemon.stop();
    await until(
      () =>
        one<{ status: string }>(
          w,
          "SELECT status FROM machine WHERE id = ?",
          machineId,
        )?.status !== "online",
      10_000,
    );
    await expect(
      propose({ path: join(daemon.dataDir, "other"), machineId }),
    ).rejects.toThrow(/cannot be checked/);
  });
});
