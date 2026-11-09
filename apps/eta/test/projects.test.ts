/**
 * Machines and projects through a real socket: the primary machine every host has, and the
 * directories on it that conversations belong to.
 */
import type {
  ConversationSummary,
  MachineView,
  MessageView,
  ProjectView,
} from "@eta/client-contracts";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { connect, until } from "./support/client";
import { tempDir, testHost } from "./support/host";
import { world } from "./support/world";

describe("the primary machine", () => {
  it("a conversation can have no steward, its project's or its own", async () => {
    const w = await world();
    const ada = await w.agent("Ada");
    const project = await w.project({ stewardId: ada.id });
    const group = await w.group(project.id, [ada.id], "nobody leads");
    const said = (await w.client.call("conversations", "setSteward", {
      conversationId: group.id,
      agentId: null,
      none: true,
    })) as { conversation: ConversationSummary };
    expect(said.conversation.stewardId).toBeNull();
    const back = (await w.client.call("conversations", "setSteward", {
      conversationId: group.id,
      agentId: null,
    })) as { conversation: ConversationSummary };
    expect(back.conversation.stewardId).toBe(ada.id);
  });

  it("is there from the first start, and is the same machine on the next", async () => {
    const dataDir = await tempDir();
    const first = await testHost({ dataDir });
    const before = await connect(`ws://127.0.0.1:${first.port}/ws`);
    const hello = await before.hello();
    const [machine] = hello.state.machines!.sections.list as MachineView[];
    expect(machine).toMatchObject({
      kind: "primary",
      status: "online",
      fingerprint: null,
    });
    expect(machine?.os).toBe(process.platform);
    expect(machine?.home).toBeTruthy();
    before.close();
    await first.close();

    const second = await testHost({ dataDir });
    const after = await connect(`ws://127.0.0.1:${second.port}/ws`);
    const list = (await after.hello()).state.machines!.sections
      .list as MachineView[];
    // One machine, with the id the projects already name.
    expect(list.map((m) => m.id)).toEqual([machine!.id]);
    after.close();
  });

  it("can be renamed, and the name sticks across a restart", async () => {
    const dataDir = await tempDir();
    const w = await world({ dataDir });
    const [machine] = w.client.section<MachineView[]>("machines", "list")!;
    const renamed = (await w.client.call("machines", "rename", {
      machineId: machine!.id,
      name: "the desk",
    })) as { machine: MachineView };
    expect(renamed.machine.name).toBe("the desk");
    await expect(
      w.client.call("machines", "rename", { machineId: "nope", name: "x" }),
    ).rejects.toThrow(/no such machine/);
    await expect(
      w.client.call("machines", "rename", {
        machineId: machine!.id,
        name: " ",
      }),
    ).rejects.toThrow(/needs name/);
    await w.host.close();

    const again = await world({ dataDir });
    expect(
      again.client.section<MachineView[]>("machines", "list")?.[0]?.name,
    ).toBe("the desk");
  });
});

describe("projects", () => {
  it("makes one from a directory that exists, named for it", async () => {
    const w = await world();
    const path = await tempDir("eta-project-");
    const project = await w.project({ path });
    expect(project).toMatchObject({
      path,
      name: basename(path),
      kind: "project",
      stewardId: null,
      archived: false,
    });
    const machines = w.client.section<MachineView[]>("machines", "list")!;
    expect(project.machineId).toBe(machines[0]!.id);
    await until(
      () =>
        w.client
          .section<ProjectView[]>("projects", "list")
          ?.some((entry) => entry.id === project.id) === true,
    );
  });

  it("checks the path before it takes it", async () => {
    const w = await world();
    const dir = await tempDir();
    await writeFile(join(dir, "file.txt"), "not a directory");
    const create = (path: string) =>
      w.client.call("projects", "create", { path });
    await expect(create("relative/path")).rejects.toThrow(/absolute/);
    await expect(create(join(dir, "missing"))).rejects.toThrow(
      /no such directory/,
    );
    await expect(create(join(dir, "file.txt"))).rejects.toThrow(
      /not a directory/,
    );
    await expect(
      w.client.call("projects", "create", { path: dir, machineId: "nope" }),
    ).rejects.toThrow(/no such machine/);
    await expect(
      w.client.call("projects", "create", { path: dir, stewardId: "nobody" }),
    ).rejects.toThrow(/no such agent/);
    // None of that left a project behind.
    expect(
      w.client
        .section<ProjectView[]>("projects", "list")
        ?.filter((entry) => entry.kind !== "agent_home"),
    ).toEqual([]);
  });

  it("returns the project that is already there, spelled however the path is", async () => {
    const w = await world();
    const path = await tempDir("eta-project-");
    const first = (await w.client.call("projects", "create", { path })) as {
      project: ProjectView;
      existed: boolean;
    };
    const second = (await w.client.call("projects", "create", {
      path: `${path}/`,
      name: "ignored",
    })) as { project: ProjectView; existed: boolean };
    expect(first.existed).toBe(false);
    expect(second.existed).toBe(true);
    expect(second.project.id).toBe(first.project.id);
    expect(second.project.name).toBe(basename(path));
    // One that was put away comes back when it is asked for again.
    await w.client.call("projects", "update", {
      projectId: first.project.id,
      archived: true,
    });
    const back = (await w.client.call("projects", "create", { path })) as {
      project: ProjectView;
    };
    expect(back.project).toMatchObject({
      id: first.project.id,
      archived: false,
    });
  });

  it("renames and archives", async () => {
    const w = await world();
    const project = await w.project();
    const { project: renamed } = (await w.client.call("projects", "update", {
      projectId: project.id,
      name: "the repo",
      archived: true,
    })) as { project: ProjectView };
    expect(renamed).toMatchObject({ name: "the repo", archived: true });
    await expect(
      w.client.call("projects", "update", { projectId: project.id, name: "" }),
    ).rejects.toThrow(/needs name|needs a name/);
    await expect(
      w.client.call("projects", "update", { projectId: "nope", name: "x" }),
    ).rejects.toThrow(/no such project/);
  });
});

describe("a project's steward", () => {
  it("is set at creation or later, and cleared with null", async () => {
    const w = await world();
    const ada = await w.agent("Ada");
    const bob = await w.agent("Bob");
    const project = await w.project({ stewardId: ada.id });
    expect(project.stewardId).toBe(ada.id);

    const set = (agentId: string | null) =>
      w.client.call("projects", "setSteward", {
        projectId: project.id,
        agentId,
      }) as Promise<{ project: ProjectView }>;
    expect((await set(bob.id)).project.stewardId).toBe(bob.id);
    expect((await set(null)).project.stewardId).toBeNull();
    await expect(set("nobody")).rejects.toThrow(/no such agent/);
    await expect(
      w.client.call("projects", "setSteward", { projectId: project.id }),
    ).rejects.toThrow(/needs agentId/);
  });

  it("writes a system row into each conversation that follows the project, and only those", async () => {
    const w = await world();
    const ada = await w.agent("Ada");
    const bob = await w.agent("Bob");
    const project = await w.project({ stewardId: ada.id });
    const following = await w.group(project.id, [ada.id], "follows");
    const own = await w.group(project.id, [ada.id], "has its own");
    const archived = await w.group(project.id, [ada.id], "put away");
    await w.client.call("conversations", "setSteward", {
      conversationId: own.id,
      agentId: ada.id,
    });
    await w.client.call("conversations", "update", {
      conversationId: archived.id,
      archived: true,
    });
    const chat = (
      (await w.client.call("agents", "direct", { agentId: ada.id })) as {
        conversation: ConversationSummary;
      }
    ).conversation;
    for (const id of [following.id, own.id, archived.id, chat.id])
      await w.watch(id);
    const systemRows = (id: string): MessageView[] =>
      w.rows(id).filter((row) => row.kind === "system");
    // Pointing `own` at the steward it already had changes nothing, so it wrote no row.
    const ownBefore = systemRows(own.id).length;
    expect(ownBefore).toBe(0);

    await w.client.call("projects", "setSteward", {
      projectId: project.id,
      agentId: bob.id,
    });
    await until(() => systemRows(following.id).length === 1);
    const [row] = systemRows(following.id);
    expect(row).toMatchObject({
      kind: "system",
      author: "system",
      status: "done",
      data: { event: "steward", from: ada.id, to: bob.id },
    });
    expect(row?.text).toContain("Bob");
    // A conversation with a steward of its own, a put-away one and a private chat did not change.
    expect(systemRows(own.id)).toHaveLength(ownBefore);
    expect(systemRows(archived.id)).toHaveLength(0);
    expect(systemRows(chat.id)).toHaveLength(0);
    // The old steward is still a member, and can still be mentioned.
    expect(
      w.client.section<{ agentId: string }[]>(
        `conversations.${following.id}`,
        "members",
      ),
    ).toEqual([expect.objectContaining({ agentId: ada.id })]);

    // Setting the same steward again says nothing.
    await w.client.call("projects", "setSteward", {
      projectId: project.id,
      agentId: bob.id,
    });
    expect(systemRows(following.id)).toHaveLength(1);
  });
});
