/**
 * The stores over a real (in-memory) database with the shipped migrations: the rules that live in
 * the schema and the statements, with no socket and no session in the way.
 */
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStore } from "../src/agents/store";
import { ConversationStore } from "../src/conversations/store";
import { Timeline } from "../src/conversations/timeline";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { MachineStore } from "../src/machines/store";
import { ProjectStore } from "../src/projects/store";

const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function stores() {
  const db = openDatabase(":memory:");
  open.push(db);
  applyMigrations(db, loadMigrations());
  const agents = new AgentStore(db);
  const machines = new MachineStore(db);
  const projects = new ProjectStore(db);
  const conversations = new ConversationStore(db);
  const timeline = new Timeline(db);
  const machine = machines.ensurePrimary({
    name: "box",
    home: "/home/u",
    os: "linux",
  });
  const project = projects.create({
    machineId: machine.id,
    path: "/work/a",
    name: "a",
  });
  return {
    db,
    agents,
    machines,
    projects,
    conversations,
    timeline,
    machine,
    project,
  };
}

describe("agents", () => {
  it("keeps what was given, lists by name without regard to case, and clears with null", () => {
    const { agents } = stores();
    const zed = agents.create({ name: "zed" });
    const ada = agents.create({
      name: "Ada",
      instructions: "x",
      persona: "Executor",
      model: "p:m",
      thinkingLevel: "high",
    });
    expect(agents.list().map((agent) => agent.name)).toEqual(["Ada", "zed"]);
    expect(zed).toMatchObject({
      instructions: "",
      persona: "",
      model: null,
      thinkingLevel: null,
    });
    expect(ada).toMatchObject({ model: "p:m", thinkingLevel: "high" });

    const edited = agents.update(ada.id, { name: "Ada L", model: null })!;
    expect(edited).toMatchObject({
      name: "Ada L",
      model: null,
      instructions: "x",
      thinkingLevel: "high",
    });
    expect(edited.updatedAt).toBeGreaterThanOrEqual(ada.updatedAt);
    expect(agents.update("nope", { name: "x" })).toBeUndefined();
    expect(agents.remove(ada.id)).toBe(true);
    expect(agents.remove(ada.id)).toBe(false);
    expect(agents.get(ada.id)).toBeUndefined();
  });
});

describe("machines", () => {
  it("has one primary, whose id and name stay while its facts are refreshed", () => {
    const { machines, machine, db } = stores();
    machines.rename(machine.id, "the desk");
    const again = machines.ensurePrimary({
      name: "other",
      home: "/home/v",
      os: "darwin",
    });
    expect(again.id).toBe(machine.id);
    expect(again).toMatchObject({
      name: "the desk",
      home: "/home/v",
      os: "darwin",
      kind: "primary",
      status: "online",
    });
    expect(machines.list()).toHaveLength(1);
    // The schema will not hold a second one, whatever asks.
    expect(() =>
      db.exec(
        "INSERT INTO machine (id, kind, name, created_at) VALUES ('x', 'primary', 'x', 0)",
      ),
    ).toThrow(/UNIQUE/);
    expect(machines.rename("nope", "x")).toBeUndefined();
  });

  it("has room for the machines that come later", () => {
    const { machines, db } = stores();
    db.exec(
      `INSERT INTO machine (id, kind, name, status, fingerprint, created_at)
       VALUES ('d1', 'daemon', 'laptop', 'pending', 'ab:cd', 1), ('s1', 'ssh', 'box', 'offline', NULL, 2)`,
    );
    // The primary first, then the rest by name.
    expect(machines.list().map((m) => [m.kind, m.status])).toEqual([
      ["primary", "online"],
      ["ssh", "offline"],
      ["daemon", "pending"],
    ]);
    expect(() =>
      db.exec(
        "INSERT INTO machine (id, kind, name, created_at) VALUES ('q', 'cloud', 'x', 0)",
      ),
    ).toThrow(/CHECK/);
  });
});

describe("projects", () => {
  it("are unique per machine and path, and the same path may live on two machines", () => {
    const { projects, machine, db } = stores();
    expect(() =>
      projects.create({
        machineId: machine.id,
        path: "/work/a",
        name: "again",
      }),
    ).toThrow(/UNIQUE/);
    db.exec(
      "INSERT INTO machine (id, kind, name, created_at) VALUES ('d1', 'daemon', 'laptop', 1)",
    );
    expect(
      projects.create({ machineId: "d1", path: "/work/a", name: "there" })
        .machineId,
    ).toBe("d1");
    expect(projects.byPath(machine.id, "/work/a")?.name).toBe("a");
    expect(projects.byPath(machine.id, "/work/none")).toBeUndefined();
  });

  it("lose their steward when the steward is deleted, and keep everything else", () => {
    const { projects, agents, project } = stores();
    const ada = agents.create({ name: "Ada" });
    expect(projects.setSteward(project.id, ada.id)?.stewardId).toBe(ada.id);
    agents.remove(ada.id);
    expect(projects.get(project.id)).toMatchObject({
      stewardId: null,
      name: "a",
    });
    expect(projects.update(project.id, { archived: true })?.archived).toBe(
      true,
    );
    expect(projects.setSteward("nope", null)).toBeUndefined();
  });
});

describe("the timeline", () => {
  function conversation() {
    const s = stores();
    const ada = s.agents.create({ name: "Ada" });
    const conv = s.conversations.create({
      projectId: s.project.id,
      kind: "group",
      name: "c",
      agentIds: [ada.id],
    });
    return { ...s, ada, conv };
  }

  it("numbers rows densely per conversation, and a reply keeps its place", () => {
    const { timeline, conversations, project, ada, conv } = conversation();
    const other = conversations.create({
      projectId: project.id,
      kind: "group",
      name: "o",
      agentIds: [],
    });
    const user = timeline.append({
      conversationId: conv.id,
      kind: "message",
      author: "user",
      text: "hi",
    });
    const reply = timeline.queueReply(conv.id, ada.id, user);
    const elsewhere = timeline.append({
      conversationId: other.id,
      kind: "message",
      author: "user",
      text: "hi",
    });
    const later = timeline.append({
      conversationId: conv.id,
      kind: "message",
      author: "user",
      text: "again",
    });
    expect([user.seq, reply.seq, later.seq, elsewhere.seq]).toEqual([
      1, 2, 3, 1,
    ]);
    expect(conversations.get(conv.id)?.lastSeq).toBe(3);
    expect(reply).toMatchObject({
      status: "queued",
      replyToId: user.id,
      rootMessageId: user.id,
      revision: 1,
    });

    const done = timeline.finish(reply.id, {
      status: "done",
      text: "hello",
      thinking: "hm",
    })!;
    expect(done).toMatchObject({
      seq: 2,
      revision: 2,
      text: "hello",
      thinking: "hm",
    });
    expect(() =>
      timeline.append({
        conversationId: "nope",
        kind: "message",
        author: "user",
      }),
    ).toThrow(/no such conversation/);
  });

  it("lets a reply move only the ways it may, and end once", () => {
    const { timeline, ada, conv } = conversation();
    const user = timeline.append({
      conversationId: conv.id,
      kind: "message",
      author: "user",
      text: "hi",
    });
    const reply = timeline.queueReply(conv.id, ada.id, user);
    expect(
      timeline.transition(reply.id, ["working"], "waiting_for_input"),
    ).toBeUndefined();
    expect(timeline.transition(reply.id, ["queued"], "working")?.status).toBe(
      "working",
    );
    expect(
      timeline.transition(reply.id, ["queued"], "working"),
    ).toBeUndefined();
    expect(
      timeline.finish(reply.id, { status: "stopped", text: "part" })?.status,
    ).toBe("stopped");
    // A second ending (the race of a stop and a finish) changes nothing.
    expect(
      timeline.finish(reply.id, { status: "done", text: "late" }),
    ).toBeUndefined();
    expect(timeline.get(reply.id)).toMatchObject({
      status: "stopped",
      text: "part",
    });
    expect(
      timeline.finish("nope", { status: "done", text: "" }),
    ).toBeUndefined();
  });

  it("windows and pages from the newest back", () => {
    const { timeline, conv } = conversation();
    for (let n = 1; n <= 10; n += 1)
      timeline.append({
        conversationId: conv.id,
        kind: "message",
        author: "user",
        text: `${n}`,
      });
    const newest = timeline.window(conv.id, 4);
    expect(newest.messages.map((m) => m.seq)).toEqual([7, 8, 9, 10]);
    expect(newest.hasMore).toBe(true);
    const older = timeline.page(conv.id, 7, 10);
    expect(older.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(older.hasMore).toBe(false);
    expect(timeline.page(conv.id, 7, 6).hasMore).toBe(false);
    expect(timeline.page(conv.id, 7, 5).hasMore).toBe(true);
    expect(timeline.after(conv.id, 8).map((m) => m.seq)).toEqual([9, 10]);
  });

  it("counts mentions under a root, in one conversation", () => {
    const { timeline, conv, conversations, project, ada } = conversation();
    const other = conversations.create({
      projectId: project.id,
      kind: "group",
      name: "o",
      agentIds: [],
    });
    const mention = (conversationId: string, root: string) =>
      timeline.append({
        conversationId,
        kind: "mention",
        author: "agent",
        agentId: ada.id,
        rootMessageId: root,
      });
    mention(conv.id, "r1");
    mention(conv.id, "r1");
    mention(conv.id, "r2");
    mention(other.id, "r1");
    timeline.append({
      conversationId: conv.id,
      kind: "message",
      author: "agent",
      rootMessageId: "r1",
    });
    expect(timeline.countMentions(conv.id, "r1")).toBe(2);
    expect(timeline.countMentions(conv.id, "r2")).toBe(1);
    expect(timeline.countMentions(conv.id, "none")).toBe(0);
  });

  it("digests what a list shows: unread agent rows that ended, and the last thing said", () => {
    const { timeline, conv, ada } = conversation();
    expect(timeline.digest(conv.id, 0)).toEqual({
      unread: 0,
      preview: "",
      lastMessageAt: null,
    });
    const user = timeline.append({
      conversationId: conv.id,
      kind: "message",
      author: "user",
      text: "hello  there\nfriend",
    });
    const reply = timeline.queueReply(conv.id, ada.id, user);
    // Nothing to read yet: the reply is only a place.
    expect(timeline.digest(conv.id, 0).unread).toBe(0);
    timeline.finish(reply.id, { status: "done", text: "  a long\nanswer " });
    timeline.system(conv.id, "Bob is now the steward.", { event: "steward" });
    const digest = timeline.digest(conv.id, 0);
    // The system row is neither unread nor the preview; whitespace is one line's worth.
    expect(digest).toMatchObject({ unread: 1, preview: "a long answer" });
    expect(digest.lastMessageAt).toBeGreaterThan(0);
    expect(timeline.digest(conv.id, 2).unread).toBe(0);
  });

  it("says where each agent stands, and the busier state wins", () => {
    const { timeline, agents, conv, conversations } = conversation();
    const bob = agents.create({ name: "Bob" });
    conversations.addParticipant(conv.id, bob.id);
    const user = timeline.append({
      conversationId: conv.id,
      kind: "message",
      author: "user",
      text: "hi",
    });
    const a = timeline.queueReply(conv.id, "ada", user);
    const b1 = timeline.queueReply(conv.id, bob.id, user);
    const b2 = timeline.queueReply(conv.id, bob.id, user);
    timeline.transition(b1.id, ["queued"], "working");
    timeline.transition(b2.id, ["queued"], "working");
    timeline.transition(b2.id, ["working"], "waiting_for_input");
    expect(timeline.memberStatuses(conv.id).get("ada")).toBe("queued");
    expect(timeline.memberStatuses(conv.id).get(bob.id)).toBe(
      "waiting_for_input",
    );
    expect(timeline.agentStatuses().get(bob.id)).toBe("waiting_for_input");
    // Waiting its turn is not working.
    expect(timeline.agentStatuses().has("ada")).toBe(false);
    timeline.transition(a.id, ["queued"], "working");
    timeline.transition(a.id, ["working"], "stopping");
    expect(timeline.agentStatuses().get("ada")).toBe("working");
  });

  it("fails what was in flight, and only that", () => {
    const { timeline, conv, ada } = conversation();
    const user = timeline.append({
      conversationId: conv.id,
      kind: "message",
      author: "user",
      text: "hi",
    });
    const queued = timeline.queueReply(conv.id, ada.id, user);
    const done = timeline.queueReply(conv.id, ada.id, user);
    timeline.finish(done.id, { status: "done", text: "fine" });
    expect(timeline.failInterrupted("restarted")).toEqual([conv.id]);
    expect(timeline.get(queued.id)).toMatchObject({
      status: "failed",
      text: "restarted",
      data: { code: "restart" },
    });
    expect(timeline.get(done.id)).toMatchObject({
      status: "done",
      text: "fine",
    });
    expect(timeline.get(user.id)?.status).toBe("done");
    expect(timeline.failInterrupted("again")).toEqual([]);
  });

  it("goes with its conversation, and a reply outlives its agent", () => {
    const { timeline, agents, conversations, ada, conv } = conversation();
    const user = timeline.append({
      conversationId: conv.id,
      kind: "message",
      author: "user",
      text: "hi",
    });
    const reply = timeline.queueReply(conv.id, ada.id, user);
    agents.remove(ada.id);
    expect(timeline.get(reply.id)?.agentId).toBe(ada.id);
    expect(conversations.participants(conv.id)).toEqual([]);
  });
});

describe("conversations", () => {
  it("keep their members in the order they came, and take each once", () => {
    const { conversations, agents, project } = stores();
    const [a, b, c] = ["A", "B", "C"].map((name) => agents.create({ name }));
    const conv = conversations.create({
      projectId: project.id,
      kind: "group",
      name: "c",
      agentIds: [c!.id, a!.id],
    });
    expect(conversations.addParticipant(conv.id, b!.id)).toBe(true);
    expect(conversations.addParticipant(conv.id, b!.id)).toBe(false);
    expect(conversations.participants(conv.id).map((p) => p.agentId)).toEqual([
      c!.id,
      a!.id,
      b!.id,
    ]);
    expect(conversations.removeParticipant(conv.id, a!.id)).toBe(true);
    expect(conversations.removeParticipant(conv.id, a!.id)).toBe(false);
  });

  it("move a member's mark only forward", () => {
    const { conversations, agents, project } = stores();
    const a = agents.create({ name: "A" });
    const conv = conversations.create({
      projectId: project.id,
      kind: "group",
      name: "c",
      agentIds: [a.id],
    });
    conversations.setSeen(conv.id, a.id, 5);
    conversations.setSeen(conv.id, a.id, 3);
    expect(conversations.participant(conv.id, a.id)?.lastSeq).toBe(5);
    conversations.setSession(conv.id, a.id, "eta-1", project.machineId);
    expect(conversations.participant(conv.id, a.id)).toMatchObject({
      sessionId: "eta-1",
      machineId: project.machineId,
      lastSeq: 5,
    });
  });

  it("find a private chat by agent and project, and put away an agent's chats", () => {
    const { conversations, agents, project } = stores();
    const a = agents.create({ name: "A" });
    const b = agents.create({ name: "B" });
    const chat = conversations.create({
      projectId: project.id,
      kind: "direct",
      name: "A",
      agentIds: [a.id],
    });
    const group = conversations.create({
      projectId: project.id,
      kind: "group",
      name: "g",
      agentIds: [a.id, b.id],
    });
    expect(conversations.directOf(project.id, a.id)?.id).toBe(chat.id);
    expect(conversations.directOf(project.id, b.id)).toBeUndefined();
    expect(conversations.archiveDirectOf(a.id)).toEqual([chat.id]);
    expect(conversations.get(chat.id)?.archived).toBe(true);
    expect(conversations.get(group.id)?.archived).toBe(false);
    expect(conversations.archiveDirectOf(a.id)).toEqual([]);
    conversations.renameDirect(project.id, "Ada");
    expect(conversations.get(chat.id)?.name).toBe("Ada");
    expect(conversations.get(group.id)?.name).toBe("g");
  });

  it("clear their own steward when the steward is deleted", () => {
    const { conversations, agents, project } = stores();
    const a = agents.create({ name: "A" });
    const conv = conversations.create({
      projectId: project.id,
      kind: "group",
      name: "c",
      agentIds: [],
    });
    expect(conversations.setSteward(conv.id, a.id)?.stewardId).toBe(a.id);
    agents.remove(a.id);
    expect(conversations.get(conv.id)?.stewardId).toBeNull();
  });

  it("mark read forward only, never past the newest row", () => {
    const { conversations, timeline, agents, project } = stores();
    const a = agents.create({ name: "A" });
    const conv = conversations.create({
      projectId: project.id,
      kind: "group",
      name: "c",
      agentIds: [a.id],
    });
    for (let n = 0; n < 3; n += 1)
      timeline.append({
        conversationId: conv.id,
        kind: "message",
        author: "user",
      });
    expect(conversations.markRead(conv.id, 2)?.readSeq).toBe(2);
    expect(conversations.markRead(conv.id, 1)?.readSeq).toBe(2);
    expect(conversations.markRead(conv.id, 50)?.readSeq).toBe(3);
    expect(conversations.markRead("nope", 1)).toBeUndefined();
  });
});
