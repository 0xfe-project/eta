import type { Extension, SlashCommand } from "../../extensions/types";
import { MachinesLayer } from "./layer";
import { machinesMessages } from "./messages";

const machines: SlashCommand = {
  name: "machines",
  args: [],
  summary: {
    en: "List the machines, add one, approve or remove one",
    zh: "查看机器，添加、批准或移除",
  },
  examples: [
    {
      input: "/machines",
      summary: {
        en: "Add another machine for agents to work on",
        zh: "再加一台给智能体干活的机器",
      },
    },
  ],
  requiredOps: [
    "machines.addresses",
    "machines.enroll",
    "machines.approve",
    "machines.removePreview",
    "machines.remove",
  ],
  run: (ctx) => {
    ctx.openLayer((handle) => <MachinesLayer handle={handle} />);
  },
};

const extension: Extension = {
  id: "machines",
  messages: machinesMessages,
  commands: [machines],
};

export default extension;
