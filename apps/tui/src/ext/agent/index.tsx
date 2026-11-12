import type { AgentView } from "@eta/client-contracts";
import type {
  Extension,
  ShellContext,
  SlashCommand,
} from "../../extensions/types";
import type { ShellWatch } from "./shell-watch";
import { translatorFor } from "../../i18n/messages";
import { AgentPicker } from "../kit/agent-picker";
import { findAgent } from "../kit/agents";
import { ordinaryAgents } from "../kit/captain";
import { noteShell } from "./kept-notice";
import { readLive } from "./live";
import { agentMessages } from "./messages";
import { editAgent } from "./session";
import { watchShell } from "./shell-watch";

/** Edits the agent in the shell `shell` watches, and stops watching when the edit ends. */
async function editInShell(shell: ShellWatch, agentId: string): Promise<void> {
  try {
    await editAgent(shell, agentId);
  } finally {
    shell.stop();
  }
}

function pickThenEdit(ctx: ShellContext, initialId?: string): void {
  const t = translatorFor(agentMessages, ctx.locale);
  // Two Enters read at once reach onPick twice before the picker is gone.
  let picked = false;
  ctx.openLayer((handle) => (
    <AgentPicker
      title={t("pickTitle")}
      handle={handle}
      initialId={initialId}
      onPick={(agent) => {
        if (picked) return;
        picked = true;
        // The picker shows, so its shell is the one showing now.
        const shell = watchShell(ctx);
        handle.close();
        ctx.reportFailure(editInShell(shell, agent.id));
      }}
    />
  ));
}

const agent: SlashCommand = {
  name: "agent",
  args: [
    {
      name: "agent",
      required: false,
      summary: {
        en: "The agent's name or id; without it, a list to choose from",
        zh: "智能体的名字或 id；不给时从列表里选",
      },
    },
  ],
  summary: {
    en: "Edit an agent's settings as YAML in your editor",
    zh: "用编辑器以 YAML 编辑智能体的设定",
  },
  examples: [
    {
      input: "/agent",
      summary: { en: "Choose an agent to edit", zh: "选一个智能体来编辑" },
    },
    {
      input: "/agent Ada",
      summary: { en: "Edit the agent named Ada", zh: "编辑名叫 Ada 的智能体" },
    },
  ],
  requiredOps: ["agents.update", "agents.runtimes"],
  run: async (ctx, argText) => {
    const t = translatorFor(agentMessages, ctx.locale);
    if (argText === "") {
      pickThenEdit(ctx);
      return;
    }
    // Before any await: the shell and wire the command was typed in.
    const shell = watchShell(ctx);
    try {
      const sections = await readLive(shell.ctx.wire, "agents", {
        ready: (s) => Array.isArray(s.list),
        failure: t("noState", { target: "agents" }),
      });
      const found = findAgent(
        ordinaryAgents(sections.list as AgentView[]),
        argText,
      );
      if ("agent" in found) await editAgent(shell, found.agent.id);
      else if ("ambiguous" in found) pickThenEdit(ctx, found.ambiguous[0]?.id);
      else ctx.notify(t("notFound", { text: argText }), "error");
    } finally {
      shell.stop();
    }
  },
};

const extension: Extension = {
  id: "agent",
  messages: agentMessages,
  commands: [agent],
  onConnected: (ctx) => noteShell(ctx),
};

export default extension;
