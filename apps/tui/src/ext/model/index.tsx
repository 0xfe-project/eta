import type { Extension, SlashCommand } from "../../extensions/types";
import { modelMessages } from "./messages";
import { ModelLayer } from "./model-layer";

const modelCommand: SlashCommand = {
  name: "model",
  args: [
    {
      name: "agent",
      required: false,
      summary: {
        en: "The agent's name, the start of it, or its id; asked when left out",
        zh: "智能体的名字、名字开头或 id；不给时会先问",
      },
    },
  ],
  summary: {
    en: "Choose an agent's model and thinking level",
    zh: "选智能体的模型和思考档",
  },
  examples: [
    {
      input: "/model",
      summary: { en: "Pick the agent from a list", zh: "从列表里选智能体" },
    },
    {
      input: "/model Ada",
      summary: { en: "Set Ada's model", zh: "设 Ada 的模型" },
    },
  ],
  requiredOps: ["agents.update", "agents.runtimes"],
  run: (ctx, argText) => {
    ctx.openLayer((handle) => <ModelLayer handle={handle} query={argText} />);
  },
};

const extension: Extension = {
  id: "model",
  messages: modelMessages,
  commands: [modelCommand],
};

export default extension;
