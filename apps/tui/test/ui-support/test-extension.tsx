/**
 * A feature that exists only in tests: a tab kind with titles and statuses the test sets, a
 * pinned entry, and commands that reach the shell's context the way real features do.
 */
import type {
  Extension,
  LayerHandle,
  NoticeTone,
  ShellContext,
  SlashCommand,
  TabStatus,
} from "../../src/extensions/types";
import { Text, useInput } from "ink";
import { useInputActive } from "../../src/extensions/react";

export interface TestFeature {
  extension: Extension;
  titles: Map<string, string>;
  statuses: Map<string, TabStatus>;
  /** Keys the open test layers and tab views saw, as `<who>:<input>`. */
  keys: string[];
  ran: string[];
  layers: LayerHandle[];
  ctx: () => ShellContext;
}

function cmd(
  name: string,
  run: SlashCommand["run"],
  requiredOps: string[] = [],
): SlashCommand {
  return {
    name,
    args: [],
    summary: { en: `Test ${name}`, zh: `测试 ${name}` },
    examples: [],
    requiredOps,
    run,
  };
}

export function testFeature(): TestFeature {
  const titles = new Map<string, string>();
  const statuses = new Map<string, TabStatus>();
  const keys: string[] = [];
  const ran: string[] = [];
  const layers: LayerHandle[] = [];
  let lastCtx: ShellContext | undefined;

  function ChatView({ tab, active }: { tab: { id: string }; active: boolean }) {
    const inputActive = useInputActive();
    useInput((input) => keys.push(`chat-${tab.id}:${input}`), {
      isActive: active && inputActive,
    });
    return <Text>Chat view {tab.id}</Text>;
  }

  function TestLayer({ name }: { name: string }) {
    const inputActive = useInputActive();
    useInput((input) => keys.push(`layer-${name}:${input}`), {
      isActive: inputActive,
    });
    return <Text>Layer {name}</Text>;
  }

  const extension: Extension = {
    id: "zz-test",
    views: [
      {
        kind: "chat",
        Component: ChatView,
        useTitle: (tab) => titles.get(tab.id) ?? tab.id,
        useStatus: (tab) => statuses.get(tab.id),
      },
    ],
    pinnedTabs: [
      { id: "pending", useLabel: () => "Pending 3", onSelect: () => {} },
    ],
    commands: [
      cmd("open-tab", (ctx, arg) => {
        lastCtx = ctx;
        const [kind = "", id = ""] = arg.split(" ");
        ctx.openTab({ kind, id });
      }),
      cmd("close-tab", (ctx, arg) => {
        const [kind = "", id = ""] = arg.split(" ");
        ctx.closeTab({ kind, id });
      }),
      cmd("layer", (ctx, arg) => {
        lastCtx = ctx;
        layers.push(ctx.openLayer(() => <TestLayer name={arg} />));
      }),
      cmd("say", (ctx, arg) => {
        const [tone, ...words] = arg.split(" ");
        ctx.notify(words.join(" "), tone as NoticeTone);
      }),
      cmd("boom", () => {
        throw new Error("the command broke");
      }),
      cmd("needy", () => {
        ran.push("needy");
      }, ["thing.do"]),
      cmd("grab", (ctx) => {
        lastCtx = ctx;
      }),
    ],
  };

  return {
    extension,
    titles,
    statuses,
    keys,
    ran,
    layers,
    ctx: () => {
      if (!lastCtx) throw new Error("no command has run yet");
      return lastCtx;
    },
  };
}
