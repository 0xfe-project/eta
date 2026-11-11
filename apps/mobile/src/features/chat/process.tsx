import type {
  SessionHistoryResult,
  ViewMessageRow,
} from "@eta/client-contracts";
import type { Chat } from "./conversation";
import type { LogBlock, RunBlock, ToolBlock } from "./run";
import type { Step } from "./steps";
import { computed, List, signal, Text, untracked, View } from "nsh";
import { t } from "../../i18n";
import { open } from "../../nav/stack";
import { reason } from "../../ui/format";
import { Icon } from "../../ui/Icon";
import { Markdown } from "../../ui/Markdown";
import { Header, Page } from "../../ui/Page";
import { Empty, Failed, Loading } from "../../ui/States";
import { toast } from "../../ui/toast";
import { call } from "../../wire/target";
import { agentName, replyBlocks } from "./conversation";
import { Counts } from "./ProcessBox";
import { useSessions } from "./session";
import { stepOf } from "./steps";
import { ToolScreen } from "./ToolScreen";
import { shapeOf, withoutAnsi } from "./tool-shape";

/** How many of the last steps 04 shows before 「Earlier N steps」. */
const LAST_STEPS = 10;
/** How many older messages one page back asks for: the size of the view's own window. */
const HISTORY_PAGE = 200;
/** How much of a command's output shows under its row; the rest is in 03i. */
const OUTPUT_LINES = 8;

type Row =
  | { key: string; type: "thinking"; text: string; last: boolean }
  | { key: string; type: "earlier"; count: number }
  | { key: string; type: "step"; step: Step; first: boolean }
  | {
      key: string;
      type: "words";
      id: string;
      text: string;
      who: "agent" | "user";
    }
  | { key: string; type: "note"; verb: string; text: string; failed: boolean }
  | { key: string; type: "stop"; prompt: string };

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return t("chat.process.underMinute");
  if (minutes < 60) return t("chat.process.minutes", { count: minutes });
  return t("chat.process.hours", { count: Math.round(minutes / 60) });
}

/** The newest command in a list of steps, whose output is open from the start. */
const newestCommand = (rows: readonly Row[]) =>
  rows.find((row) => row.type === "step" && isCommand(row.step.block));

const isCommand = (block: ToolBlock) => shapeOf(block).kind === "command";

function RowLine(props: {
  verb: string;
  failed?: boolean;
  children?: unknown;
  onPress?: (() => void) | undefined;
  border: boolean;
}) {
  return (
    <View
      role="button"
      onPress={props.onPress}
      class={`h-11 shrink-0 flex-row items-center gap-3 px-4 active:bg-muted ${props.border ? "border-t border-border" : ""}`}
    >
      <Text
        class={`min-w-[32px] shrink-0 text-sm leading-4 ${props.failed ? "text-state-error" : "text-muted-foreground"}`}
      >
        {props.verb}
      </Text>
      {props.children as never}
    </View>
  );
}

function StepRow(props: {
  step: Step;
  border: boolean;
  /** A command's output is open under it. */
  expanded: boolean;
  onPress: () => void;
  onDetail: () => void;
}) {
  const output = () => {
    const text = withoutAnsi(props.step.block.output ?? "").trimEnd();
    const lines = text.split("\n");
    return lines.slice(Math.max(0, lines.length - OUTPUT_LINES)).join("\n");
  };
  return (
    <View class="shrink-0">
      <RowLine
        verb={props.step.verb}
        failed={props.step.refused}
        border={props.border}
        onPress={props.onPress}
      >
        <Text class="truncate grow basis-0 text-md leading-4 text-foreground">
          {props.step.text}
        </Text>
        <Counts added={props.step.added} removed={props.step.removed} />
        <If
          when={
            props.step.failed &&
            !props.step.refused &&
            props.step.note !== undefined
          }
        >
          <Text class="text-sm leading-4 text-state-error">
            {props.step.note}
          </Text>
        </If>
        <If when={props.step.verdict !== undefined}>
          <Text class="text-sm leading-4 text-state-success">
            {props.step.verdict}
          </Text>
        </If>
      </RowLine>
      <If when={props.expanded && output() !== ""}>
        <View
          role="button"
          onPress={props.onDetail}
          class="border-t border-border bg-surface px-4 py-[10px] active:opacity-60"
        >
          <Text class="text-sm leading-[18px] text-muted-foreground">
            {output()}
          </Text>
        </View>
      </If>
    </View>
  );
}

/** The steps as 04 draws them. Newest at the bottom, opening there. */
function ProcessList(props: {
  rows: readonly Row[];
  expandAll: () => void;
  folds: {
    get: (key: string) => boolean | undefined;
    set: (key: string, open: boolean) => void;
  };
  detail: (block: ToolBlock) => void;
  onLoadMore?: (() => void) | undefined;
}) {
  const reversed = computed(() => props.rows.toReversed());
  const newest = computed(() => newestCommand(reversed())?.key);
  const opened = (key: string) => props.folds.get(key) ?? key === newest();
  return (
    <List
      testID="process"
      each={reversed()}
      inverted
      estimatedItemSize={44}
      style={{ flex: 1 }}
      onLoadMore={props.onLoadMore}
    >
      {(row) => {
        const of = <K extends Row["type"]>(type: K) => {
          const value = row();
          return value.type === type
            ? (value as Extract<Row, { type: K }>)
            : undefined;
        };
        return (
          <View>
            <If when={of("thinking")}>
              {(item) => (
                <View class={item().last ? "border-b border-border" : ""}>
                  <View
                    role="button"
                    onPress={() =>
                      props.folds.set(
                        item().key,
                        props.folds.get(item().key) !== true,
                      )
                    }
                    class="h-11 shrink-0 flex-row items-center gap-3 bg-surface px-4 active:bg-muted"
                  >
                    <Text class="grow basis-0 text-md leading-4 text-muted-foreground">
                      {t("chat.thinking.fold", {
                        count: item().text.length.toLocaleString("en-US"),
                      })}
                    </Text>
                    <Icon
                      name={
                        props.folds.get(item().key) === true
                          ? "caretDown"
                          : "caretRight"
                      }
                      size={14}
                      color="faint"
                    />
                  </View>
                  <If when={props.folds.get(item().key) === true}>
                    <View class="border-t border-border px-4 py-[10px]">
                      <Text class="text-sm leading-[18px] text-muted-foreground">
                        {item().text}
                      </Text>
                    </View>
                  </If>
                </View>
              )}
            </If>
            <If when={of("earlier")}>
              {(item) => (
                <View
                  role="button"
                  onPress={props.expandAll}
                  class="h-11 shrink-0 flex-row items-center border-t border-border px-4 active:bg-muted"
                >
                  <Text class="text-md leading-4 text-muted-foreground">
                    {t("chat.process.earlier", { count: item().count })}
                  </Text>
                </View>
              )}
            </If>
            <If when={of("step")}>
              {(item) => {
                const command = () => isCommand(item().step.block);
                return (
                  <StepRow
                    step={item().step}
                    border={!item().first}
                    expanded={command() && opened(item().key)}
                    onDetail={() => props.detail(item().step.block)}
                    onPress={() => {
                      if (command())
                        props.folds.set(item().key, !opened(item().key));
                      else props.detail(item().step.block);
                    }}
                  />
                );
              }}
            </If>
            <If when={of("words")}>
              {(item) => (
                <View class="border-t border-border px-4 py-[10px]">
                  <If
                    when={item().who === "agent"}
                    else={
                      <Text class="text-base leading-[23px] text-muted-foreground">
                        {item().text}
                      </Text>
                    }
                  >
                    <Markdown text={item().text} />
                  </If>
                </View>
              )}
            </If>
            <If when={of("note")}>
              {(item) => (
                <RowLine verb={item().verb} failed={item().failed} border>
                  <Text class="truncate grow basis-0 text-md leading-4 text-foreground">
                    {item().text}
                  </Text>
                </RowLine>
              )}
            </If>
            <If when={of("stop")}>
              {(item) => (
                <View class="h-[52px] shrink-0 flex-row items-center gap-3 border-t-2 border-foreground px-4">
                  <Text class="min-w-[32px] shrink-0 text-sm leading-4 text-foreground">
                    {t("chat.step.stoppedAt")}
                  </Text>
                  <Text class="truncate grow basis-0 text-md leading-4 text-foreground">
                    {item().prompt}
                  </Text>
                </View>
              )}
            </If>
          </View>
        );
      }}
    </List>
  );
}

function useFolds() {
  const state = signal<Record<string, boolean>>({});
  return {
    get: (key: string) => state()[key],
    set: (key: string, value: boolean) =>
      state.update((all) => ({ ...all, [key]: value })),
  };
}

/** 04: a reply's steps. Its thinking first, then the last ten, the older ones one press away. */
function replyRows(
  blocks: readonly RunBlock[],
  all: boolean,
  question: string | undefined,
): Row[] {
  const thinking = blocks.flatMap((block) =>
    block.type === "thinking" ? [block.text] : [],
  );
  const tools = blocks.flatMap((block) =>
    block.type === "tool" ? [block] : [],
  );
  const hidden = all ? 0 : Math.max(0, tools.length - LAST_STEPS);
  return [
    ...(thinking.length === 0
      ? []
      : [
          {
            key: "thinking",
            type: "thinking" as const,
            text: thinking.join("\n\n"),
            last: hidden === 0 && tools.length > 0,
          },
        ]),
    ...(hidden === 0
      ? []
      : [{ key: "earlier", type: "earlier" as const, count: hidden }]),
    ...tools.slice(hidden).map(
      (block, index): Row => ({
        key: block.id,
        type: "step",
        step: stepOf(block),
        first: index === 0 && thinking.length === 0 && hidden === 0,
      }),
    ),
    ...(question === undefined
      ? []
      : [{ key: "stop", type: "stop" as const, prompt: question }]),
  ];
}

/** 04 for a reply in a conversation. */
export function ProcessScreen(props: { chat: Chat; messageId: string }) {
  const chat = props.chat;
  const message = computed(() =>
    chat.messages().find((row) => row.id === props.messageId),
  );
  const blocks = computed(() => {
    const row = message();
    return row === undefined ? [] : replyBlocks(chat, row).blocks;
  });
  const question = () =>
    chat
      .questions()
      .find(
        (interaction) =>
          interaction.replyId === props.messageId ||
          (interaction.replyId === null &&
            interaction.agentId === message()?.agentId),
      )?.prompt;
  const all = signal(false);
  const folds = useFolds();
  const rows = computed(() => replyRows(blocks(), all(), question()));
  const steps = () => blocks().filter((block) => block.type !== "text").length;
  const duration = () => {
    const row = message();
    if (row === undefined) return "";
    return formatDuration(
      (replyBlocks(chat, row).live ? Date.now() : row.updatedAt) -
        row.createdAt,
    );
  };
  const detail = (block: ToolBlock) => {
    const lookup = () =>
      blocks().find(
        (other): other is ToolBlock =>
          other.type === "tool" && other.id === block.id,
      );
    open(`tool:${block.id}`, () => (
      <ToolScreen
        block={block}
        lookup={lookup}
        sessionId={chat.sessionOf(message()?.agentId ?? null)}
      />
    ));
  };
  return (
    <Page>
      <Header
        title={t("chat.process.title", { name: agentName(message()?.agentId) })}
        right={
          <Text class="text-sm leading-[18px] text-muted-foreground">
            {t("chat.process.summary", {
              count: steps(),
              duration: duration(),
            })}
          </Text>
        }
      />
      <ProcessList
        rows={rows()}
        expandAll={() => all.set(true)}
        folds={folds}
        detail={detail}
      />
    </Page>
  );
}

function logRows(blocks: readonly LogBlock[]): Row[] {
  let first = true;
  return blocks.map((block): Row => {
    const border = !first;
    first = false;
    switch (block.type) {
      case "thinking":
        return {
          key: block.id,
          type: "thinking",
          text: block.text,
          last: false,
        };
      case "text":
        return {
          key: block.id,
          type: "words",
          id: block.id,
          text: block.text,
          who: "agent",
        };
      case "user":
        return {
          key: block.id,
          type: "words",
          id: block.id,
          text: block.text,
          who: "user",
        };
      case "tool":
        return {
          key: block.id,
          type: "step",
          step: stepOf(block),
          first: !border,
        };
      case "error":
        return {
          key: block.id,
          type: "note",
          verb: block.aborted ? t("chat.log.stopped") : t("chat.log.failed"),
          text: block.text,
          failed: !block.aborted,
        };
      case "summary":
        return {
          key: block.id,
          type: "note",
          verb: t("chat.log.summary"),
          text: block.text,
          failed: false,
        };
    }
  });
}

/** A session's steps in plain words (04): what it read, changed, ran, was stopped from. */
export function ProcessView(props: { sessionId: string }) {
  const sessions = useSessions(() => [props.sessionId]);
  const older = signal<readonly ViewMessageRow[]>([]);
  const done = signal(false);
  const loading = signal(false);
  const folds = useFolds();
  const blocks = computed(() => sessions.log(props.sessionId, older()));
  const rows = computed(() => logRows(blocks()));
  const loadEarlier = () => {
    const window = sessions.rows(props.sessionId);
    const oldest = (untracked(older)[0] ?? window[0])?.seq;
    if (oldest === undefined || untracked(loading) || untracked(done)) return;
    const shown = untracked(older).length;
    if (shown >= sessions.before(props.sessionId)) return;
    loading.set(true);
    call<SessionHistoryResult>("sessions", "history", {
      session: props.sessionId,
      beforeSeq: oldest,
      limit: HISTORY_PAGE,
    }).then(
      (page) => {
        older.update((rows) => [...page.rows, ...rows]);
        if (page.rows.length < HISTORY_PAGE) done.set(true);
        loading.set(false);
      },
      (error: unknown) => {
        loading.set(false);
        toast(t("common.failed", { message: reason(error) }));
      },
    );
  };
  const detail = (block: ToolBlock) => {
    const lookup = () =>
      blocks().find(
        (other): other is ToolBlock =>
          other.type === "tool" && other.id === block.id,
      );
    open(`tool:${block.id}`, () => (
      <ToolScreen block={block} lookup={lookup} sessionId={props.sessionId} />
    ));
  };
  return (
    <If
      when={sessions.loaded(props.sessionId)}
      else={
        <If when={sessions.missing(props.sessionId)} else={<Loading />}>
          <Failed title={t("chat.log.unavailable")} />
        </If>
      }
    >
      <If when={rows().length > 0} else={<Empty title={t("chat.log.empty")} />}>
        <ProcessList
          rows={rows()}
          expandAll={() => undefined}
          folds={folds}
          detail={detail}
          onLoadMore={loadEarlier}
        />
      </If>
    </If>
  );
}
