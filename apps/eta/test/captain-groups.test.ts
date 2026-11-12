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
  MessageView,
} from "@eta/client-contracts";
import type { Request } from "./support/models";
import type { World } from "./support/world";
import { mkdir, writeFile } from "node:fs/promises";
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

interface Counts {
  projects: number;
  conversations: number;
}

function counts(w: World): Counts {
  const one = (sql: string) => w.host.db.query<{ n: number }, []>(sql).get()!.n;
  return {
    projects: one("SELECT COUNT(*) AS n FROM project"),
    conversations: one("SELECT COUNT(*) AS n FROM conversation"),
  };
}

function members(w: World, conversationId: string): string[] {
  return w.host.db
    .query<{ agent_id: string }, [string]>(
      "SELECT agent_id FROM participant WHERE conversation_id = ? ORDER BY agent_id",
    )
    .all(conversationId)
    .map((row) => row.agent_id);
}

interface ProjectRow {
  id: string;
  machineId: string;
  path: string;
  name: string;
  kind: string;
  stewardId: string | null;
}

function projectRows(w: World): ProjectRow[] {
  return w.host.db
    .query<ProjectRow, []>(
      `SELECT id, machine_id AS machineId, path, name, kind, steward_id AS stewardId
         FROM project`,
    )
    .all();
}

function machineStatus(w: World, id: string): string | undefined {
  return (
    w.host.db
      .query<{ status: string }, [string]>(
        "SELECT status FROM machine WHERE id = ?",
      )
      .get(id)?.status ?? undefined
  );
}

function primaryId(w: World): string {
  return w.host.db
    .query<{ id: string }, []>("SELECT id FROM machine WHERE kind = 'primary'")
    .get()!.id;
}

function operation(w: World, id: string): CaptainOperationView {
  return w.host.product.captain.store.operation(id)!;
}

const decide = (w: World, operationId: string, decision: string) =>
  w.client.call("captain", "decideOperation", {
    operationId,
    decision,
  }) as Promise<{
    operation: CaptainOperationView;
  }>;

/**
 * Captain's side of the conversation, scripted: it proposes what `proposal()` says when the user
 * asks, and when it is told the group exists, assigns work in it.
 */
function captainScript(proposal: () => Record<string, unknown>) {
  const told: string[] = [];
  const { models, requests } = scriptedModels((request: Request) => {
    if (request.agent !== "Captain") return say("On it.");
    if (request.lastRole === "toolResult") {
      if (request.last.includes("Captain assignment")) return say("Assigned.");
      return say("Proposed; waiting for you.");
    }
    if (request.last.includes("Your proposed group")) {
      told.push(request.last);
      const created = /conversationId: (\S+)/.exec(request.last)?.[1];
      if (created !== undefined)
        return call("assign_in_group", {
          conversationId: created,
          text: "Please start on the repository.",
        });
      return say("Understood.");
    }
    if (request.last.includes("make a group"))
      return call("propose_group", proposal());
    return say("Captain ready.");
  });
  return { models, requests, told };
}

async function captainConversation(w: World): Promise<string> {
  const { conversationId } = await w.host.product.captain.direct();
  await w.watch(conversationId);
  return conversationId;
}

function card(w: World, conversationId: string): MessageView | undefined {
  return w
    .rows(conversationId)
    .find(
      (row) =>
        row.kind === "system" &&
        (row.data as { event?: string }).event === "captain_group_proposal",
    );
}

describe("propose_group is Captain's", () => {
  it("is offered to Captain's session and to no other agent's", async () => {
    const { models, requests } = scriptedModels(() => say("Hello."));
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const project = await w.project({ stewardId: ada.id });
    const group = await w.group(project.id, [ada.id]);
    await w.watch(group.id);
    const toAda = await w.send(group.id, "Hi Ada");
    await w.settled(group.id, toAda.replies[0]!.id);
    const captain = await captainConversation(w);
    const toCaptain = await w.send(captain, "Hi Captain");
    await w.settled(captain, toCaptain.replies[0]!.id);

    const adaTools = requests.find((request) => request.agent === "Ada")!.tools;
    const captainTools = requests.find(
      (request) => request.agent === "Captain",
    )!.tools;
    expect(captainTools).toContain("propose_group");
    expect(captainTools).toContain("assign_in_group");
    expect(adaTools).not.toContain("propose_group");
    expect(adaTools).not.toContain("assign_in_group");
  });

  it("reaches a Captain session that an older build opened and pinned", async () => {
    const dataDir = await tempDir();
    const first = scriptedModels(() => say("Hello."));
    const before = await world({ ...options, models: first.models, dataDir });
    const captain = await captainConversation(before);
    const sent = await before.send(captain, "Hi");
    await before.settled(captain, sent.replies[0]!.id);
    const { session_id: sessionId } = before.host.db
      .query<{ session_id: string }, [string]>(
        "SELECT session_id FROM participant WHERE conversation_id = ?",
      )
      .get(captain)!;
    // What a build without the tool left in the journal: a pin that does not name it.
    const managed = (await before.host.server.sessions.session(sessionId))!;
    const pinned = managed.session.kernel.config.read("activeToolNames");
    expect(pinned).toContain("propose_group");
    managed.session.kernel.config.update({
      activeToolNames: pinned.filter((name) => name !== "propose_group"),
    });
    await before.host.close();

    const second = scriptedModels(() => say("Hello again."));
    const after = await world({ ...options, models: second.models, dataDir });
    await after.watch(captain);
    const again = await after.send(captain, "Still there?");
    await after.settled(captain, again.replies[0]!.id);
    expect(
      after.host.db
        .query<{ session_id: string }, [string]>(
          "SELECT session_id FROM participant WHERE conversation_id = ?",
        )
        .get(captain)!.session_id,
    ).toBe(sessionId);
    expect(second.requests.at(-1)!.tools).toContain("propose_group");
  });
});

describe("a group Captain proposes", () => {
  it("is only a card until the user creates it; then Captain assigns work in it", async () => {
    let proposal: Record<string, unknown> = {};
    const script = captainScript(() => proposal);
    const w = await world({ ...options, models: script.models });
    const ada = await w.agent("Ada");
    const bola = await w.agent("Bola");
    const project = await w.project({ stewardId: ada.id, name: "Repo" });
    proposal = {
      name: "Launch",
      projectId: project.id,
      memberIds: [ada.id, bola.id],
      stewardId: bola.id,
      goal: "Ship the launch page",
    };
    const captain = await captainConversation(w);
    const start = counts(w);

    const asked = await w.send(captain, "Please make a group for the launch.");
    await w.settled(captain, asked.replies[0]!.id);
    expect(counts(w)).toEqual(start);
    const row = card(w, captain)!;
    const data = row.data as unknown as CaptainGroupProposalRowData;
    expect(data.status).toBe("pending");
    expect(data.proposal).toMatchObject({
      name: "Launch",
      projectId: project.id,
      projectName: "Repo",
      memberIds: [ada.id, bola.id],
      stewardId: bola.id,
      goal: "Ship the launch page",
      originConversationId: captain,
    });
    // The card and the group panel's list are the same record.
    expect(operation(w, data.operationId)).toMatchObject({
      kind: "create_group",
      status: "pending",
      requiresApproval: true,
    });

    const { operation: decided } = await decide(w, data.operationId, "approve");
    expect(decided.status).toBe("applied");
    const groupId = (decided.result as { conversationId: string })
      .conversationId;
    const group = w.host.db
      .query<
        {
          name: string;
          project_id: string;
          steward_id: string | null;
          goal: string;
        },
        [string]
      >(
        "SELECT name, project_id, steward_id, goal FROM conversation WHERE id = ?",
      )
      .get(groupId)!;
    expect(group).toEqual({
      name: "Launch",
      project_id: project.id,
      steward_id: bola.id,
      goal: "Ship the launch page",
    });
    expect(members(w, groupId)).toEqual([ada.id, bola.id].sort());
    expect(counts(w)).toEqual({
      ...start,
      conversations: start.conversations + 1,
    });
    await w.watch(groupId);
    const firstRow = w.rows(groupId)[0]!;
    expect(firstRow).toMatchObject({ kind: "system", seq: 1 });
    expect((firstRow.data as { event?: string }).event).toBe("captain_created");
    await until(
      () =>
        (card(w, captain)!.data as unknown as CaptainGroupProposalRowData)
          .status === "applied",
    );

    // Captain hears it in the same conversation and goes on with assign_in_group.
    await until(() =>
      w.host.product.captain.store
        .assignments()
        .some((assignment) => assignment.conversationId === groupId),
    );
    expect(script.told[0]).toContain(`conversationId: ${groupId}`);
    await until(() =>
      w.rows(groupId).some((message) => message.author === "captain"),
    );
  });

  it("makes nothing when rejected, and Captain is told", async () => {
    let proposal: Record<string, unknown> = {};
    const script = captainScript(() => proposal);
    const w = await world({ ...options, models: script.models });
    const ada = await w.agent("Ada");
    const project = await w.project({ stewardId: ada.id });
    proposal = {
      name: "Docs",
      projectId: project.id,
      memberIds: [ada.id],
      stewardId: ada.id,
    };
    const captain = await captainConversation(w);
    const asked = await w.send(captain, "Please make a group for docs.");
    await w.settled(captain, asked.replies[0]!.id);
    const start = counts(w);
    const data = card(w, captain)!
      .data as unknown as CaptainGroupProposalRowData;
    const { operation: decided } = await decide(w, data.operationId, "reject");
    expect(decided.status).toBe("rejected");
    expect(counts(w)).toEqual(start);
    await until(() => script.told.length === 1);
    expect(script.told[0]).toContain("rejected");
    await until(
      () =>
        (card(w, captain)!.data as unknown as CaptainGroupProposalRowData)
          .status === "rejected",
    );
    // Decided once is decided.
    await expect(decide(w, data.operationId, "approve")).rejects.toThrow(
      /rejected/,
    );
  });
});

describe("a group of the same name", () => {
  it("stops the proposal, with the group that is there", async () => {
    let proposal: Record<string, unknown> = {};
    const script = captainScript(() => proposal);
    const w = await world({ ...options, models: script.models });
    const ada = await w.agent("Ada");
    const project = await w.project({ stewardId: ada.id });
    const existing = await w.group(project.id, [ada.id], "Launch");
    proposal = {
      name: " Launch ",
      projectId: project.id,
      memberIds: [ada.id],
      stewardId: ada.id,
    };
    const captain = await captainConversation(w);
    const asked = await w.send(captain, "Please make a group.");
    await w.settled(captain, asked.replies[0]!.id);
    expect(w.host.product.captain.store.operations()).toEqual([]);
    expect(card(w, captain)).toBeUndefined();
    const result = script.requests.find(
      (request) =>
        request.agent === "Captain" && request.lastRole === "toolResult",
    )!;
    expect(result.last).toContain("Conflict");
    expect(result.last).toContain(existing.id);

    const captainId = w.host.product.captain.identity()!.agentId;
    const again = {
      name: "Launch",
      projectId: project.id,
      memberIds: [ada.id],
      stewardId: ada.id,
      originConversationId: captain,
      captainAgentId: captainId,
    };
    await expect(
      w.host.product.captain.proposeGroup(again),
    ).rejects.toBeInstanceOf(GroupConflictError);

    // An archived group of that name is not in the way.
    await w.client.call("conversations", "update", {
      conversationId: existing.id,
      archived: true,
    });
    await expect(
      w.host.product.captain.proposeGroup(again),
    ).resolves.toBeDefined();
  });

  it("stops the confirmation when one appeared in the meantime", async () => {
    const w = await world(options);
    const ada = await w.agent("Ada");
    const project = await w.project({ stewardId: ada.id });
    const captain = await captainConversation(w);
    const captainId = w.host.product.captain.identity()!.agentId;
    const { operation: proposed } = await w.host.product.captain.proposeGroup({
      name: "Launch",
      projectId: project.id,
      memberIds: [ada.id],
      stewardId: ada.id,
      originConversationId: captain,
      captainAgentId: captainId,
    });
    const meanwhile = await w.group(project.id, [ada.id], "Launch");
    const start = counts(w);
    const { operation: decided } = await decide(w, proposed.id, "approve");
    expect(decided.status).toBe("failed");
    expect(decided.error).toContain(meanwhile.id);
    expect(counts(w)).toEqual(start);
    await until(
      () =>
        (card(w, captain)!.data as unknown as CaptainGroupProposalRowData)
          .error === decided.error,
    );
  });

  it("counts for a new directory once that directory has become a project", async () => {
    const w = await world(options);
    const ada = await w.agent("Ada");
    const captain = await captainConversation(w);
    const captainId = w.host.product.captain.identity()!.agentId;
    const dir = await tempDir("eta-clone-");
    const { operation: proposed } = await w.host.product.captain.proposeGroup({
      name: "Launch",
      path: dir,
      memberIds: [ada.id],
      stewardId: ada.id,
      originConversationId: captain,
      captainAgentId: captainId,
    });
    expect(proposed.payload).toMatchObject({ projectId: null, path: dir });
    // The user added the directory and made a group of that name before confirming.
    const project = await w.project({ path: dir });
    await w.group(project.id, [ada.id], "Launch");
    const { operation: decided } = await decide(w, proposed.id, "approve");
    expect(decided.status).toBe("failed");
    expect(decided.error).toMatch(/already exists/);
  });
});

describe("a new directory", () => {
  async function setup() {
    const w = await world(options);
    const ada = await w.agent("Ada");
    const captain = await captainConversation(w);
    const captainId = w.host.product.captain.identity()!.agentId;
    const propose = (fields: {
      path?: string;
      projectId?: string;
      machineId?: string;
    }) =>
      w.host.product.captain.proposeGroup({
        name: "Clone",
        ...fields,
        memberIds: [ada.id],
        stewardId: ada.id,
        originConversationId: captain,
        captainAgentId: captainId,
      });
    return { w, ada, captain, captainId, propose };
  }

  it("has to be an existing directory that is nobody's workspace and not archived", async () => {
    const { w, ada, captainId, propose } = await setup();
    const root = await tempDir("eta-paths-");
    const file = join(root, "notes.txt");
    await writeFile(file, "x");
    const start = counts(w);
    await expect(propose({ path: join(root, "missing") })).rejects.toThrow(
      /no such directory/,
    );
    await expect(propose({ path: file })).rejects.toThrow(/not a directory/);
    await expect(propose({ path: "relative/dir" })).rejects.toThrow(/absolute/);
    await expect(
      propose({ path: agentHome(w.host.dataDir, ada.id) }),
    ).rejects.toThrow(/agent's own workspace/);
    await expect(
      propose({ path: agentHome(w.host.dataDir, captainId) }),
    ).rejects.toThrow(/agent's own workspace/);
    const adaHome = projectRows(w).find(
      (project) =>
        project.kind === "agent_home" && project.stewardId === ada.id,
    )!;
    await expect(propose({ projectId: adaHome.id })).rejects.toThrow(
      /agent's own workspace/,
    );
    const archived = await w.project({ path: await tempDir("eta-old-") });
    await w.client.call("projects", "update", {
      projectId: archived.id,
      archived: true,
    });
    await expect(propose({ projectId: archived.id })).rejects.toThrow(
      /archived/,
    );
    await expect(propose({ path: archived.path })).rejects.toThrow(/archived/);
    await expect(
      propose({ path: root, projectId: archived.id }),
    ).rejects.toThrow(/either projectId or path/);
    expect(counts(w)).toEqual({ ...start, projects: start.projects + 1 });
    expect(w.host.product.captain.store.operations()).toEqual([]);
  });

  it("becomes a project stewarded by the group's steward when the user creates the group", async () => {
    const { w, ada, propose } = await setup();
    const parent = await tempDir("eta-captain-");
    const dir = join(parent, "small-repo");
    await mkdir(dir);
    const start = counts(w);
    const { operation: proposed } = await propose({ path: `${dir}/` });
    expect(proposed.payload).toMatchObject({
      projectId: null,
      path: dir,
      projectName: "small-repo",
    });
    expect(counts(w)).toEqual(start);
    const { operation: decided } = await decide(w, proposed.id, "approve");
    expect(decided.status).toBe("applied");
    const result = decided.result as {
      conversationId: string;
      projectId: string;
      projectCreated: boolean;
    };
    expect(result.projectCreated).toBe(true);
    const project = projectRows(w).find((row) => row.id === result.projectId)!;
    expect(project).toMatchObject({
      path: dir,
      name: "small-repo",
      kind: "project",
      stewardId: ada.id,
      machineId: primaryId(w),
    });
    // The steward is the project's, followed rather than copied, as the dialog makes it.
    expect(
      w.host.db
        .query<{ steward_id: string | null; project_id: string }, [string]>(
          "SELECT steward_id, project_id FROM conversation WHERE id = ?",
        )
        .get(result.conversationId),
    ).toEqual({ steward_id: null, project_id: project.id });
  });

  it("fails at confirmation when the directory went away", async () => {
    const { w, propose } = await setup();
    const parent = await tempDir("eta-captain-");
    const dir = join(parent, "gone");
    await mkdir(dir);
    const { operation: proposed } = await propose({ path: dir });
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true });
    const start = counts(w);
    const { operation: decided } = await decide(w, proposed.id, "approve");
    expect(decided.status).toBe("failed");
    expect(decided.error).toMatch(/no such directory/);
    expect(counts(w)).toEqual(start);
  });

  it("fails at confirmation when a member was deleted", async () => {
    const { w, ada, propose } = await setup();
    const dir = await tempDir("eta-captain-");
    const { operation: proposed } = await propose({ path: dir });
    await w.client.call("agents", "delete", { agentId: ada.id });
    const { operation: decided } = await decide(w, proposed.id, "approve");
    expect(decided.status).toBe("failed");
    expect(decided.error).toContain(`member ${ada.id} does not exist`);
  });

  it("is checked on the machine it is on", async () => {
    const { w, ada, propose } = await setup();
    const daemon = await startDaemon(w.host, w.client, { name: "gpu-box" });
    await approve(w.client, daemon);
    const there = join(daemon.dataDir, "checkout");
    await mkdir(there);
    await expect(
      propose({
        path: join(daemon.dataDir, "nowhere"),
        machineId: daemon.machineId,
      }),
    ).rejects.toThrow(/no such directory/);
    await expect(
      propose({ path: there, machineId: "no-such" }),
    ).rejects.toThrow(/no such machine/);
    const { operation: proposed } = await propose({
      path: there,
      machineId: daemon.machineId,
    });
    const { operation: decided } = await decide(w, proposed.id, "approve");
    expect(decided.status).toBe("applied");
    const project = projectRows(w).find(
      (row) => row.id === (decided.result as { projectId: string }).projectId,
    )!;
    expect(project).toMatchObject({
      machineId: daemon.machineId,
      path: there,
      stewardId: ada.id,
    });

    // Offline, the machine cannot say, so the proposal is refused.
    await daemon.stop();
    await until(() => machineStatus(w, daemon.machineId) !== "online", 10_000);
    await expect(
      propose({
        path: join(daemon.dataDir, "other"),
        machineId: daemon.machineId,
      }),
    ).rejects.toThrow(/cannot be checked/);
  });
});

describe("members", () => {
  it("are at least one, never Captain, and include the steward", async () => {
    const w = await world(options);
    const ada = await w.agent("Ada");
    const bola = await w.agent("Bola");
    const project = await w.project();
    const captain = await captainConversation(w);
    const captainId = w.host.product.captain.identity()!.agentId;
    const propose = (memberIds: string[], stewardId: string, name = "Team") =>
      w.host.product.captain.proposeGroup({
        name,
        projectId: project.id,
        memberIds,
        stewardId,
        originConversationId: captain,
        captainAgentId: captainId,
      });
    await expect(propose([], ada.id)).rejects.toThrow(/at least one member/);
    await expect(propose([ada.id, captainId], ada.id)).rejects.toThrow(
      /Captain cannot be a member/,
    );
    await expect(propose([ada.id], bola.id)).rejects.toThrow(
      /steward has to be a member/,
    );
    await expect(propose(["nobody"], "nobody")).rejects.toThrow(
      /does not exist/,
    );
    await expect(propose([ada.id], ada.id, "  ")).rejects.toThrow(
      /needs a name/,
    );
  });
});
