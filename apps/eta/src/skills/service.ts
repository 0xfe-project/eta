import type {
  SkillFileArgs,
  SkillFileRequest,
  SkillFileResults,
  SkillTarget,
} from "@eta/client-contracts";
import type { MachineHub } from "../machines/hub";
import type { MachineStore } from "../machines/store";
import type { ProjectStore } from "../projects/store";
import { SkillFiles } from "@eta/server";

interface SkillFileServiceOptions {
  machines: Pick<MachineStore, "get">;
  projects: Pick<ProjectStore, "get">;
  hub: Pick<MachineHub, "link">;
  local?: SkillFiles;
}
export class SkillFileService {
  readonly #local: SkillFiles;
  readonly #options: SkillFileServiceOptions;
  constructor(options: SkillFileServiceOptions) {
    this.#options = options;
    this.#local = options.local ?? new SkillFiles();
  }

  async call<A extends keyof SkillFileArgs>(
    action: A,
    target: SkillTarget,
    args: SkillFileArgs[A],
  ): Promise<{ target: SkillTarget; result: SkillFileResults[A] }> {
    if (!target || typeof target.machineId !== "string")
      throw new Error("skill_files:machine_required");
    const machine = this.#options.machines.get(target.machineId);
    if (!machine) throw new Error("skill_files:machine_removed");
    if (machine.status !== "online")
      throw new Error(`skill_files:machine_${machine.status}`);
    if (!machine.home) throw new Error("skill_files:home_unknown");
    if (target.home !== machine.home)
      throw new Error(`skill_files:home_changed: ${machine.home}`);
    if (target.scope !== "personal" && target.scope !== "project")
      throw new Error("skill_files:invalid_scope");
    let projectPath: string | undefined;
    if (target.scope === "project") {
      if (!target.projectId) throw new Error("skill_files:project_required");
      const project = this.#options.projects.get(target.projectId);
      if (!project || project.archived)
        throw new Error("skill_files:project_removed");
      if (project.machineId !== machine.id)
        throw new Error("skill_files:project_machine_mismatch");
      projectPath = project.path;
      if (action !== "list" && target.projectPath !== projectPath)
        throw new Error("skill_files:project_changed");
    }
    const link =
      machine.kind === "daemon"
        ? this.#options.hub.link(machine.id)
        : undefined;
    if (machine.kind === "daemon" && !link)
      throw new Error("skill_files:machine_offline");
    if (machine.kind !== "primary" && machine.kind !== "daemon")
      throw new Error("skill_files:machine_unsupported");
    const epoch = link?.epoch ?? 0;
    if (action !== "list" && target.epoch !== epoch)
      throw new Error("skill_files:target_changed");
    const request = {
      action,
      args,
      location: {
        home: machine.home,
        scope: target.scope,
        ...(projectPath === undefined ? {} : { projectPath }),
      },
    } as SkillFileRequest;
    const result = link
      ? await link.daemon("skillFiles", request, { timeoutMs: 30_000 })
      : await this.#local.execute(request);
    if (link && this.#options.hub.link(machine.id) !== link)
      throw new Error("skill_files:connection_changed_result_unknown");
    return {
      target: {
        ...target,
        epoch,
        ...(projectPath === undefined ? {} : { projectPath }),
      },
      result: result as SkillFileResults[A],
    };
  }
}
