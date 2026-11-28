/**
 * Machines and projects through a real socket: the primary machine every host has, and the
 * directories on it that conversations belong to.
 */
import type { MachineView, ProjectView } from "@eta/client-contracts";
import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { connect, until } from "./support/client";
import { tempDir, testHost } from "./support/host";
import { world } from "./support/world";

describe("the primary machine", () => {
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
      ownerAgentId: null,
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
