import type { AssigneeOption } from "@/queries/tasks";
import { assignmentStatus } from "./computer-readiness";
import { assigneeKey, providerLabel, runtimeLabel } from "./task-format";
export interface Choice {
  key: string;
  label: string;
  children?: Choice[];
  offline?: boolean;
  status?: string;
}

/** Group actual tuples, rather than synthesizing computer/runtime/provider combinations. */
export function assigneeTree(options: AssigneeOption[]): Choice[] {
  const computers: Choice[] = [];
  for (const option of options) {
    let computer = computers.find((c) => c.key === option.computer_id);
    if (!computer) {
      computer = {
        key: option.computer_id,
        label: option.computer_name,
        children: [],
      };
      computers.push(computer);
    }
    let runtime = computer.children!.find((r) => r.key === option.runtime);
    if (!runtime) {
      runtime = {
        key: option.runtime,
        label: runtimeLabel(option.runtime),
        children: [],
      };
      computer.children!.push(runtime);
    }
    const key = assigneeKey({ kind: "remote", ...option });
    if (!runtime.children!.some((p) => p.key === key)) {
      runtime.children!.push({
        key,
        label: providerLabel(option.provider),
        status: assignmentStatus(option.runtime_state, option.online),
        offline: !option.online,
      });
    }
  }
  for (const computer of computers) {
    for (const runtime of computer.children!)
      runtime.offline = runtime.children!.every((p) => p.offline);
    computer.offline = computer.children!.every((r) => r.offline);
  }
  return [
    { key: "none", label: "未指派" },
    { key: "user", label: "我" },
    ...computers,
  ];
}
