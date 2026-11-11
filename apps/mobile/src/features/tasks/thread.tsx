import type {
  TaskActivityKind,
  TaskActivityView,
  TaskActor,
  TaskRunView,
} from "@eta/client-contracts";
import type { JSX } from "nsh";
import type { TaskDetail } from "./format";
import { signal, Text, View } from "nsh";
import { t } from "../../i18n";
import { go } from "../../nav/links";
import { AgentAvatar } from "../../ui/AgentAvatar";
import { moment } from "../../ui/format";
import { Icon } from "../../ui/Icon";
import { Markdown } from "../../ui/Markdown";
import { actorName, executor, isActive, statusLabel } from "./format";
import { openRunLog } from "./runs";

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

/** One line for what is not a comment. */
function describe(a: TaskActivityView): string | null {
  const d = a.data;
  const why = a.body ? `：${a.body}` : "";
  switch (a.kind) {
    case "status":
      return t("tasks.activity.statusChanged", {
        from: statusLabel(d.from as never),
        to: statusLabel(d.to as never),
      });
    case "title":
      return t("tasks.activity.titleChanged", { title: str(d.to) });
    case "description":
      return t("tasks.activity.descriptionChanged");
    case "conversation":
      return d.to
        ? t("tasks.activity.groupLinked")
        : t("tasks.activity.groupUnlinked");
    case "artifact":
      return t("tasks.activity.artifact", {
        title:
          typeof d.version === "number"
            ? t("tasks.activity.artifactVersion", {
                title: str(d.title),
                version: d.version,
              })
            : str(d.title),
      });
    case "run_started":
      return t("tasks.activity.started");
    case "run_completed":
      return t("tasks.activity.turnCompleted");
    case "run_nudged":
      return t("tasks.activity.nudged");
    case "run_failed":
      return t("tasks.activity.turnFailed", { reason: why });
    case "run_interrupted":
      return t("tasks.activity.turnStopped", { reason: why });
    default:
      return null;
  }
}

/** The first message already says who made it; a waiting run is said over the box. */
const UNLISTED = new Set<TaskActivityKind>(["created", "run_queued"]);
/** What gets a line of its own whatever is around it. */
const STANDALONE = new Set<TaskActivityKind>(["artifact", "run_failed"]);
/** Bookkeeping folds past this many lines in a row. */
const LOOSE_LINES = 2;
/** A sender's messages run together while they follow each other within this. */
const RUN_ON_MS = 5 * 60_000;

type Entry =
  | { kind: "comment"; id: string; activity: TaskActivityView; head: boolean }
  | { kind: "line"; id: string; activity: TaskActivityView }
  | { kind: "fold"; id: string; items: TaskActivityView[] };

const sameActor = (a: TaskActor, b: TaskActor) =>
  a.kind === b.kind && a.agentId === b.agentId;

function entries(items: TaskActivityView[]): Entry[] {
  const out: Entry[] = [];
  let loose: TaskActivityView[] = [];
  const flush = () => {
    const first = loose[0];
    if (first === undefined) return;
    if (loose.length > LOOSE_LINES)
      out.push({ kind: "fold", id: first.id, items: loose });
    else
      for (const a of loose) out.push({ kind: "line", id: a.id, activity: a });
    loose = [];
  };
  for (const a of items) {
    if (a.kind === "comment") {
      flush();
      const before = out[out.length - 1];
      const head = !(
        before?.kind === "comment" &&
        sameActor(before.activity.actor, a.actor) &&
        a.createdAt - before.activity.createdAt < RUN_ON_MS
      );
      out.push({ kind: "comment", id: a.id, activity: a, head });
    } else if (STANDALONE.has(a.kind)) {
      flush();
      out.push({ kind: "line", id: a.id, activity: a });
    } else loose.push(a);
  }
  flush();
  return out;
}

/** A face: an agent's own, a filled square for me, a muted one for eta. */
function Face(props: { actor: TaskActor }) {
  const agent = () =>
    props.actor.kind === "agent" ? props.actor.agentId : null;
  return (
    <If
      when={agent()}
      else={
        <View
          class={`size-7 shrink-0 items-center justify-center ${props.actor.kind === "user" ? "bg-foreground" : "bg-muted"}`}
        >
          <Icon
            name="user"
            size={16}
            color={
              props.actor.kind === "user"
                ? "primary-foreground"
                : "muted-foreground"
            }
          />
        </View>
      }
    >
      {(id) => <AgentAvatar id={id()} size={28} />}
    </If>
  );
}

/** Long text folds to its opening; `preview` says how, or that it needs no folding. */
function Folded(props: {
  text: string;
  preview?: string | undefined;
  lines: number;
}) {
  const open = signal(false);
  const folded = () => props.preview !== undefined && !open();
  return (
    <>
      <If when={folded()} else={<Markdown text={props.text} />}>
        <Text
          style={{ numberOfLines: props.lines }}
          class="text-base leading-[23px] text-foreground"
        >
          {props.preview}
        </Text>
      </If>
      <If when={props.preview !== undefined}>
        <Text
          onPress={() => open.update((value) => !value)}
          class="text-sm leading-[20px] text-muted-foreground"
        >
          {open() ? t("tasks.collapse") : t("tasks.expand")}
        </Text>
      </If>
    </>
  );
}

/** A description opens on its first paragraph. */
function descriptionPreview(text: string): string | undefined {
  // Past the headings a draft's description is built from (`## Goal`): they say nothing yet.
  const body = text
    .trim()
    .replace(/^#{1,6}\s.*$/gm, "")
    .trim();
  const first = body.split(/\n\s*\n/)[0] ?? "";
  return first.length < text.trim().length || first.length > 120
    ? first
    : undefined;
}

const commentPreview = (text: string) => (text.length > 240 ? text : undefined);

function Message(props: {
  actor: TaskActor;
  at: number;
  head: boolean;
  class: string;
  children: JSX.Element;
}) {
  return (
    <View class={`shrink-0 flex-row gap-[10px] px-4 ${props.class}`}>
      <If when={props.head} else={<View style={{ width: 28 }} />}>
        <Face actor={props.actor} />
      </If>
      <View class="min-w-0 grow basis-0 gap-[2px]">
        <If when={props.head}>
          <View class="flex-row items-baseline gap-2">
            <Text class="text-md leading-[20px] text-foreground">
              {actorName(props.actor)}
            </Text>
            <Text class="text-sm leading-[20px] text-muted-foreground">
              {moment(props.at)}
            </Text>
          </View>
        </If>
        {props.children}
      </View>
    </View>
  );
}

/** Something that happened, thin, under the text column. */
function Line(props: { task: () => TaskDetail; activity: TaskActivityView }) {
  const a = () => props.activity;
  const run = (): TaskRunView | undefined => {
    const kind = a().kind;
    if (kind !== "run_started" && kind !== "run_failed") return undefined;
    const found = props
      .task()
      .runs.find((candidate) => candidate.id === a().runId);
    return found !== undefined &&
      found.sessionId !== null &&
      !isActive(found.status)
      ? found
      : undefined;
  };
  const words = () => {
    const what = describe(a()) ?? "";
    if (a().kind === "run_failed") return what;
    // A run's events read as the executor's, unless they are a mentioned agent's own.
    const who =
      a().kind.startsWith("run_") && a().actor.kind !== "agent"
        ? executor(props.task())
        : a().actor;
    return `${actorName(who)} ${what}`;
  };
  return (
    <View class="shrink-0 flex-row gap-2 py-1 pl-[54px] pr-4">
      <Text
        onPress={
          a().kind === "artifact"
            ? () =>
                go.artifact(
                  str(a().data.artifactId),
                  typeof a().data.version === "number"
                    ? (a().data.version as number)
                    : undefined,
                )
            : undefined
        }
        class="min-w-0 grow basis-0 text-sm leading-[18px] text-muted-foreground"
      >
        {words()}
      </Text>
      <If when={run()}>
        {(found) => (
          <Text
            onPress={() => openRunLog(props.task().id, found().id)}
            class="text-sm leading-[18px] text-muted-foreground"
          >
            {t("tasks.log.title")}
          </Text>
        )}
      </If>
    </View>
  );
}

/** The bookkeeping between two messages, as one line that opens into it. */
function Changes(props: { task: () => TaskDetail; items: TaskActivityView[] }) {
  const open = signal(false);
  return (
    <>
      <View
        role="button"
        onPress={() => open.update((value) => !value)}
        class="h-8 shrink-0 flex-row items-center gap-[6px] pl-[54px] pr-4 active:opacity-60"
      >
        <Icon
          name={open() ? "caretDown" : "caretRight"}
          size={12}
          color="faint"
        />
        <Text class="text-sm leading-4 text-muted-foreground">
          {t("tasks.changes", { count: props.items.length })}
        </Text>
      </View>
      <If when={open()}>
        <Each of={props.items} key={(a) => a.id}>
          {(a) => <Line task={props.task} activity={a()} />}
        </Each>
      </If>
    </>
  );
}

/** The last word of a blocked task's agent: the question it waits on, drawn over the thread. */
export function openQuestion(task: TaskDetail): TaskActivityView | undefined {
  if (task.status !== "blocked") return undefined;
  const last = task.activity.filter((a) => a.kind === "comment").at(-1);
  return last === undefined || last.actor.kind === "user" ? undefined : last;
}

/** The task as a thread: the description first, then what was said, the rest thin or folded. */
export function Thread(props: {
  task: () => TaskDetail;
  onEdit: () => void;
  children?: JSX.Element;
}) {
  const task = props.task;
  const listed = () => {
    const question = openQuestion(task());
    return task().activity.filter(
      (a) =>
        a.id !== question?.id &&
        !UNLISTED.has(a.kind) &&
        (a.kind === "comment" || describe(a) !== null),
    );
  };
  const items = () => entries(listed());
  const replies = () => listed().filter((a) => a.kind === "comment").length;
  const caption = () => {
    if (replies() > 0) return t("tasks.replies", { count: replies() });
    return listed().length > 1
      ? t("tasks.changes", { count: listed().length })
      : undefined;
  };
  return (
    <>
      <Message
        actor={task().createdBy}
        at={task().createdAt}
        head
        class="pb-[10px] pt-[14px]"
      >
        <If
          when={task().description.trim() !== ""}
          else={
            <Text
              onPress={props.onEdit}
              class="text-sm leading-[20px] text-muted-foreground"
            >
              {t("tasks.addDescription")}
            </Text>
          }
        >
          <Folded
            text={task().description}
            preview={descriptionPreview(task().description)}
            lines={6}
          />
        </If>
      </Message>
      <If when={caption()}>
        {(text) => (
          <View class="shrink-0 flex-row items-center gap-2 px-4 pb-2 pt-1">
            <Text class="text-sm leading-4 text-muted-foreground">
              {text()}
            </Text>
            <View class="h-px grow basis-0 bg-border" />
          </View>
        )}
      </If>
      <Each of={items()} key={(entry) => `${entry.kind}:${entry.id}`}>
        {(entry) => {
          // The key holds the kind, so a row keeps it; what it says may grow.
          const kind = entry().kind;
          const fold = () => entry() as Extract<Entry, { kind: "fold" }>;
          const said = () =>
            entry() as Extract<Entry, { kind: "comment" | "line" }>;
          if (kind === "fold")
            return <Changes task={task} items={fold().items} />;
          if (kind === "line")
            return <Line task={task} activity={said().activity} />;
          return (
            <Message
              actor={said().activity.actor}
              at={said().activity.createdAt}
              head={(entry() as Extract<Entry, { kind: "comment" }>).head}
              class="py-2"
            >
              <Folded
                text={said().activity.body ?? ""}
                preview={commentPreview(said().activity.body ?? "")}
                lines={10}
              />
            </Message>
          );
        }}
      </Each>
      {props.children}
    </>
  );
}
