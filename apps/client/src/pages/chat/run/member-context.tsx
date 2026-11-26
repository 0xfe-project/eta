import type {
  AcpMachineList,
  SessionViewSections,
  ViewDiagnostics,
} from "@eta/client-contracts";
import { Clipboard, signal, View } from "nsh";
import {
  Button,
  Caption,
  colors,
  DetailSkeleton,
  focusRing,
  grow,
  Icon,
  Label,
  row,
  SmoothScroll,
} from "../../../components";
import { useContextUsage } from "../../../components/context-ring";
import { control, icon, space } from "../../../components/tokens";
import { uiText } from "../../../i18n";
import { follow, followSession, useHost } from "../../../services/host";
import { ToolOutput } from "./tool-code";

/** A prompt block's or a tool's row, folded. */
const foldRowHeight = { phone: 40, desktop: 32 } as const;

/** The names the settings screen gives the external runtimes; an ACP agent goes by its id. */
const RUNTIME_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "Pi",
  antigravity: "Antigravity",
  grok: "Grok Build",
  qwen: "Qwen Code",
};

/** A runtime's name: the settings screen's for the built-in ones, the label the user gave an ACP
 * agent (from the `acp` target), else its id. */
function runtimeName(id: string, acp: Record<string, AcpMachineList>) {
  if (RUNTIME_NAMES[id]) return RUNTIME_NAMES[id];
  if (!id.startsWith("acp.")) return id;
  const label = Object.values(acp)
    .flatMap((list) => list.agents ?? [])
    .find((agent) => agent.runtime === id)?.label;
  return label ?? id.slice(4);
}

/** One fold: a block of the prompt, or a tool. */
interface FoldItem {
  key: string;
  name: string;
  /** The muted words after the name: a tool's first line. */
  brief?: string;
  /** The caption at the end of the row: a block's half and size. */
  meta?: string;
  body: string;
}

/**
 * Keys for names that come from another process and may repeat: the name, and which one of them
 * this is. A position alone would move an open fold onto another row when one is added.
 */
function keyed<T extends { name: string }>(items: T[]) {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const nth = (seen.get(item.name) ?? 0) + 1;
    seen.set(item.name, nth);
    return { item, key: nth === 1 ? item.name : `${item.name}#${nth}` };
  });
}

/**
 * What a member's session has in its context, the old web Inspect: the system prompt block by
 * block (which half of the cache each is in, how long it is, its words) and the tools it can
 * call, every row folded onto its text. Read from the session's own view (`prompt`, `tools`).
 *
 * Three states are kept apart: a view still on its way is being read; a session with no `prompt`
 * (or no session yet) has not composed one, which is not a failure; only a session the host
 * cannot open is an error. An agent on an external runtime (Claude Code, Codex, an ACP agent)
 * sends its own prompt and tools: the view's `prompt` and `tools` there are eta's side of it, not
 * what the runtime sends, so they are not drawn as if they were.
 */
export function MemberContext(props: {
  session: string;
  agentId: string;
  phone: boolean;
}) {
  const host = useHost();
  const c = colors();
  const retryTick = signal(0);
  const target = () => (props.session ? `sessions.${props.session}` : "");
  followSession(() => {
    retryTick();
    return props.session || undefined;
  });
  const usage = useContextUsage(() => props.session || undefined);
  const open = signal<Record<string, boolean>>({});
  const copied = signal("");

  const agent = () => host.agent(props.agentId);
  const runtime = () => agent()?.runtime ?? "eta";
  const external = () => runtime() !== "eta";
  follow(() => (runtime().startsWith("acp.") ? "acp" : undefined));
  const arrived = () =>
    Boolean(target()) && host.state().targets[target()] !== undefined;
  const failed = () =>
    Boolean(target()) && Boolean(host.state().missing[target()]);
  const section = <K extends keyof SessionViewSections & string>(name: K) =>
    target() ? host.section<SessionViewSections[K]>(target(), name) : undefined;
  const prompt = () => section("prompt") as ViewDiagnostics | undefined;

  // The blocks cross a process boundary: checked, not assumed, so an older host leaves an empty
  // list rather than a blank screen.
  const blocks = (): FoldItem[] =>
    keyed(
      (Array.isArray(prompt()?.sections) ? prompt()!.sections : [])
        .filter((block) => block !== null && typeof block === "object")
        .map((block) => ({
          name: typeof block.name === "string" ? block.name : "?",
          stable: block.stable === true,
          text: typeof block.text === "string" ? block.text : "",
        })),
    ).map(({ item, key }) => ({
      key: `prompt:${key}`,
      name: item.name,
      meta: uiText("contextBlockMeta", {
        half: item.stable ? "stable" : "adaptive",
        chars: item.text.length.toLocaleString(),
      }),
      body: item.text,
    }));
  const tools = (): FoldItem[] => {
    const list = section("tools");
    return keyed(
      (Array.isArray(list) ? list : []).map((tool) => ({
        name: typeof tool?.name === "string" ? tool.name : "?",
        description:
          typeof tool?.description === "string" ? tool.description.trim() : "",
      })),
    ).map(({ item, key }) => ({
      key: `tool:${key}`,
      name: item.name,
      brief: (item.description.split("\n")[0] ?? "").trim(),
      body: item.description,
    }));
  };
  const summary = () => {
    const current = usage();
    if (!current) return "";
    const epoch = section("branch")?.compactionEpoch ?? 0;
    return [
      uiText("contextRing", { detail: current.detail }),
      epoch > 0 ? uiText("contextCompactions", { count: String(epoch) }) : "",
    ]
      .filter(Boolean)
      .join(" · ");
  };
  const loadingContext = () =>
    !external() && !!target() && !failed() && !arrived();
  /** The state of the read, for an eta session: what to say instead of the lists. */
  const notice = () => {
    if (external())
      return uiText("contextOtherRuntime", {
        name: agent()?.name ?? uiText("agent"),
        runtime: runtimeName(
          runtime(),
          host.section<Record<string, AcpMachineList>>("acp", "machines") ?? {},
        ),
      });
    if (!target()) return uiText("contextNoPrompt");
    if (failed()) return uiText("contextReadFailed");
    return "";
  };

  function Fold(item: () => FoldItem) {
    const opened = () => open()[item().key] === true;
    const copyLabel = () =>
      copied() === item().key
        ? uiText("copied")
        : uiText("copyBlock", { name: item().name });
    return (
      <View
        style={{
          borderLeftWidth: 1,
          borderRightWidth: 1,
          borderBottomWidth: 1,
          borderColor: c().border,
        }}
      >
        <View
          role="button"
          accessibilityLabel={item().name}
          accessibilityState={{ expanded: opened() }}
          onPress={() =>
            open.update((items) => ({
              ...items,
              [item().key]: !items[item().key],
            }))
          }
          hoverStyle={{ backgroundColor: c().selected }}
          focusVisibleStyle={focusRing(c(), "inset")}
          style={{
            ...row,
            height: props.phone ? foldRowHeight.phone : foldRowHeight.desktop,
            paddingHorizontal: space[12],
            gap: space[4],
            cursor: "pointer",
            backgroundColor: c().canvas,
          }}
        >
          <Icon
            name={opened() ? "down" : "right"}
            size={icon.sm}
            tone="muted"
          />
          <Label variant="small" lines={1} style={{ flexShrink: 0 }}>
            {item().name}
          </Label>
          <Label
            variant="small"
            tone="muted"
            lines={1}
            style={{ flex: 1, minWidth: 0 }}
          >
            {item().brief ? `· ${item().brief}` : ""}
          </Label>
          <If when={item().meta}>
            <Label variant="caption" tone="muted" style={{ flexShrink: 0 }}>
              {item().meta}
            </Label>
          </If>
        </View>
        <If when={opened()}>
          <View
            style={{
              padding: space[12],
              paddingTop: space[8],
              gap: space[4],
              backgroundColor: c().surface,
            }}
          >
            <View style={{ ...row, justifyContent: "flex-end" }}>
              <View
                role="button"
                accessibilityLabel={copyLabel()}
                onPress={() => {
                  const { key, body } = item();
                  void host.action(async () => {
                    await Clipboard.writeText(body);
                    copied.set(key);
                    setTimeout(() => {
                      if (copied() === key) copied.set("");
                    }, 2500);
                  });
                }}
                focusVisibleStyle={focusRing(c())}
                style={{
                  ...row,
                  gap: space[4],
                  height: control.sm,
                  cursor: "pointer",
                }}
              >
                <Icon
                  name={copied() === item().key ? "check" : "copy"}
                  size={icon.sm}
                  tone="muted"
                />
                <Label variant="caption" tone="muted">
                  {copied() === item().key
                    ? uiText("copied")
                    : uiText("copyAction")}
                </Label>
              </View>
            </View>
            <View selectable>
              <ToolOutput
                text={
                  item().body.replace(/^\s*\n|\s+$/g, "") ||
                  uiText("noRunDetails")
                }
              />
            </View>
          </View>
        </If>
      </View>
    );
  }

  function Group(group: {
    title: string;
    caption: string;
    items: () => FoldItem[];
    empty: string;
  }) {
    return (
      <View style={{ gap: space[4] }}>
        <View style={{ ...row, gap: space[8] }}>
          <Caption text={group.title} />
          <Label variant="caption" tone="muted" lines={1} style={grow}>
            {group.caption}
          </Label>
        </View>
        <If
          when={group.items().length}
          else={
            <Label variant="small" tone="muted">
              {group.empty}
            </Label>
          }
        >
          <View style={{ borderTopWidth: 1, borderColor: c().border }}>
            <Each of={group.items()} key={(item) => item.key}>
              {(item) => Fold(item)}
            </Each>
          </View>
        </If>
      </View>
    );
  }

  const inset = props.phone ? space[16] : space[12];
  return (
    <SmoothScroll style={grow} scrollbar={false}>
      <View style={{ padding: inset, gap: space[16] }}>
        <If
          when={!loadingContext() && !notice()}
          else={
            <If
              when={loadingContext()}
              else={
                <View style={{ alignItems: "flex-start", gap: space[8] }}>
                  <Label variant="small" tone="muted">
                    {notice()}
                  </Label>
                  <If when={failed()}>
                    <Button
                      label={uiText("retry")}
                      icon="refresh"
                      onPress={() => {
                        retryTick.update((count) => count + 1);
                        host.reconnect();
                      }}
                    />
                  </If>
                </View>
              }
            >
              <DetailSkeleton
                label={uiText("contextReading")}
                style={{ padding: 0 }}
              />
            </If>
          }
        >
          <If when={summary()}>
            <Label variant="small" tone="muted">
              {summary()}
            </Label>
          </If>
          <Group
            title={uiText("contextPrompt")}
            caption={
              prompt()
                ? uiText("contextPromptSummary", {
                    stable: prompt()!.stableChars.toLocaleString(),
                    adaptive: prompt()!.adaptiveChars.toLocaleString(),
                    count: String(blocks().length),
                  })
                : ""
            }
            items={blocks}
            empty={uiText("contextNoPrompt")}
          />
          <Group
            title={uiText("contextTools")}
            caption={uiText("contextToolCount", {
              count: String(tools().length),
            })}
            items={tools}
            empty={uiText("contextNoTools")}
          />
        </If>
      </View>
    </SmoothScroll>
  );
}
