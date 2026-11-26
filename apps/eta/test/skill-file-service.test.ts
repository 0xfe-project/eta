import type { MachineRecord } from "../src/machines/store";
import type { ProjectRecord } from "../src/projects/store";
import { describe, expect, it } from "vitest";
import { SkillFileService } from "../src/skills/service";

describe("skill target errors do not fall back", () => {
  it("distinguishes missing, pending, offline, unknown home and project errors before I/O", async () => {
    const machine = {
      id: "box",
      kind: "daemon",
      status: "online",
      home: "/fixture",
    } as MachineRecord;
    let present = true;
    let project: ProjectRecord | undefined;
    const service = new SkillFileService({
      machines: { get: () => (present ? machine : undefined) },
      projects: { get: () => project },
      hub: { link: () => undefined },
    });
    const target = {
      machineId: "box",
      home: "/fixture",
      scope: "personal" as const,
    };
    for (const status of ["pending", "offline"] as const) {
      machine.status = status;
      await expect(service.call("list", target, {})).rejects.toThrow(
        `machine_${status}`,
      );
    }
    machine.status = "online";
    present = false;
    await expect(service.call("list", target, {})).rejects.toThrow(
      "machine_removed",
    );
    present = true;
    machine.home = null;
    await expect(service.call("list", target, {})).rejects.toThrow(
      "home_unknown",
    );
    machine.home = "/fixture";
    await expect(
      service.call("list", { ...target, scope: "project" }, {}),
    ).rejects.toThrow("project_required");
    await expect(
      service.call(
        "list",
        { ...target, scope: "project", projectId: "gone" },
        {},
      ),
    ).rejects.toThrow("project_removed");
    project = {
      id: "p",
      machineId: "else",
      path: "/fixture/p",
      archived: false,
    } as ProjectRecord;
    await expect(
      service.call("list", { ...target, scope: "project", projectId: "p" }, {}),
    ).rejects.toThrow("project_machine_mismatch");
    await expect(service.call("list", target, {})).rejects.toThrow(
      "machine_offline",
    );
  });
});
