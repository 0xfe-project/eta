import type {
  Extension,
  ShellContext,
  SlashCommand,
} from "../../extensions/types";
import { needsSetup, readSetupFacts } from "./first-run";
import { setupMessages } from "./messages";
import { SetupLayer } from "./setup-layer";

/** How long the check on connecting waits for the host's facts before it lets the user be. */
const CHECK_TIMEOUT_MS = 10_000;

function openSetup(ctx: ShellContext): void {
  ctx.openLayer((handle) => <SetupLayer handle={handle} />);
}

/** The host's address, which the check on connecting is done once per. */
function hostAddress(ctx: ShellContext): string {
  const { phase } = ctx.connection.getState();
  return "url" in phase && phase.url !== undefined ? phase.url : "";
}

const setupCommand: SlashCommand = {
  name: "setup",
  args: [],
  summary: {
    en: "Open the first-time setup: connect model accounts, then create agents",
    zh: "打开首次设置：绑模型账号，再建智能体",
  },
  examples: [
    {
      input: "/setup",
      summary: {
        en: "Pick up the setup you left",
        zh: "回到离开的首次设置",
      },
    },
  ],
  requiredOps: ["agents.create"],
  run: (ctx) => openSetup(ctx),
};

/**
 * The setup extension. The first time this process connects to a host address, it opens the
 * setup when the host has no usable model or no agent.
 */
export function createSetupExtension(): Extension {
  const checked = new Set<string>();
  return {
    id: "setup",
    messages: setupMessages,
    commands: [setupCommand],
    onConnected: async (ctx) => {
      const address = hostAddress(ctx);
      if (checked.has(address)) return;
      checked.add(address);
      const facts = await readSetupFacts(
        ctx.wire,
        ctx.locale,
        CHECK_TIMEOUT_MS,
      );
      if (facts !== undefined && needsSetup(facts)) openSetup(ctx);
    },
  };
}

export default createSetupExtension();
