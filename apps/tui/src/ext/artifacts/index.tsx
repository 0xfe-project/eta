import type { Extension, SlashCommand } from "../../extensions/types";
import { createElement } from "react";
import { ArtifactsLayer } from "./layer";
import { artifactMessages } from "./messages";

const artifacts: SlashCommand = {
  name: "artifacts",
  args: [],
  summary: {
    en: "List what the agents published, and get an address to preview it",
    zh: "列出智能体发布的产物，并取得预览地址",
  },
  examples: [
    {
      input: "/artifacts",
      summary: { en: "Show the artifacts", zh: "列出产物" },
    },
  ],
  requiredOps: ["artifacts.preview"],
  run: (ctx) => {
    ctx.openLayer((handle) => createElement(ArtifactsLayer, { handle }));
  },
};

const extension: Extension = {
  id: "artifacts",
  messages: artifactMessages,
  commands: [artifacts],
};

export default extension;
