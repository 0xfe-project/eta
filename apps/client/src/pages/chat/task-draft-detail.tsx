import type {
  BoardTaskView,
  MessageView,
  TaskDraftData,
} from "@eta/client-contracts";
import type { Bounds, ScrollRef } from "nsh";
import { draftStatus } from "@eta/client-contracts";
import { computed, Scroll, View, windowSize } from "nsh";
import { TextView } from "nsh/base";
import {
  Caption,
  colors,
  grow,
  Label,
  Markdown,
  Modal,
  row,
} from "../../components";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";

export function draftTitle(message: MessageView) {
  const title = message.data.title;
  if (typeof title === "string" && title.trim()) return title;
  return message.text.trim() ? message.text : uiText("draftNoTitle");
}

function Field(props: { label: string; value: string }) {
  return (
    <View style={{ ...row, alignItems: "flex-start", gap: 8 }}>
      <Label size={12} tone="muted" style={{ width: 84 }}>
        {props.label}
      </Label>
      <Label size={13} style={{ flex: 1 }}>
        {props.value}
      </Label>
    </View>
  );
}

export function TaskDraftDetail(props: {
  message: MessageView;
  projectName?: string;
  phone: boolean;
  onClose: () => void;
}) {
  const host = useHost();
  const color = colors();
  let reader: ScrollRef | undefined;
  const data = () => props.message.data as unknown as Partial<TaskDraftData>;
  const source = computed(() => data().description ?? "");
  const description = computed(() => TextView.parse(source(), { html: false }));
  // All block wrappers share the scroll content's coordinates. Remember the block
  // under its top edge, so wrapping lines at a new width keeps the reader in place.
  const blocks: Bounds[] = [];
  let anchor: { index: number; within: number } | undefined;
  let scrollWidth = 0;
  function remember(y: number, width: number) {
    if (width !== scrollWidth) {
      scrollWidth = width;
      return;
    }
    const index = blocks.findLastIndex((block) => block && block.origin.y <= y);
    const block = blocks[index];
    anchor =
      block && y < block.origin.y + block.size.height + 16
        ? {
            index,
            within:
              Math.max(0, y - block.origin.y) / Math.max(1, block.size.height),
          }
        : undefined;
  }
  function place(index: number, bounds: Bounds) {
    const before = blocks[index];
    blocks[index] = bounds;
    if (
      anchor?.index === index &&
      before &&
      before.size.width !== bounds.size.width
    ) {
      reader?.scrollTo({
        y: bounds.origin.y + anchor.within * bounds.size.height,
        animated: false,
      });
    }
  }
  const executor = () => {
    const id = data().assignee || props.message.agentId;
    if (!id) return undefined;
    const name = host.state().missing.agents
      ? id
      : (host.agent(id)?.name ?? id);
    return data().assignee ? name : uiText("draftProposer", { name });
  };
  const execution = () =>
    [
      { label: uiText("project2"), value: props.projectName },
      {
        label: uiText("draftWorkspace"),
        value:
          data().workspace === "worktree"
            ? uiText("draftWorktree")
            : data().workspace === "local"
              ? uiText("draftLocal")
              : undefined,
      },
      { label: uiText("executor"), value: executor() },
      { label: uiText("draftBase"), value: data().base },
    ].filter((field): field is { label: string; value: string } =>
      Boolean(field.value),
    );
  const taskName = (id: string) => {
    if (host.state().missing.tasks) return id;
    const task =
      host.tasks().find((task) => task.id === id) ??
      host
        .list<BoardTaskView>("tasks", "archived")
        .find((task) => task.id === id);
    return task ? `#${task.number} ${task.title}` : id;
  };
  return (
    <Modal
      title={uiText("draftDetails")}
      width={Math.min(640, windowSize().width - 32)}
      height={props.phone ? "100%" : "85%"}
      phone={props.phone}
      phonePage={props.phone}
      overPhoneNavigation
      modalFocus
      onClose={props.onClose}
    >
      <If when={host.state().status !== "open"}>
        <View
          role="alert"
          style={{ padding: 8, backgroundColor: color().amberFill }}
        >
          <Label tone="amber">{uiText("connectionLostReconnecting")}</Label>
        </View>
      </If>
      <Scroll
        ref={(node) => {
          reader = node;
          queueMicrotask(() => node.focus());
        }}
        onScroll={(event) => remember(event.offset.y, event.size.width)}
        role="region"
        focusable
        accessibilityLabel={draftTitle(props.message)}
        style={grow}
      >
        <View selectable style={{ padding: props.phone ? 16 : 24, gap: 16 }}>
          <If
            when={props.message.kind === "task_draft"}
            else={
              <View role="alert">
                <Label>{uiText("draftCreated")}</Label>
              </View>
            }
          >
            <View style={{ gap: 6 }}>
              <Label size={12} tone="amber">
                {uiText("proposalAwaiting")}
              </Label>
              <Label weight={600} size={20} line={28}>
                {draftTitle(props.message)}
              </Label>
            </View>
            <If
              when={source().trim()}
              else={<Label tone="muted">{uiText("draftNoDescription")}</Label>}
            >
              <Each of={description().blocks} key="index">
                {(block, index) => (
                  <View onLayout={({ bounds }) => place(index(), bounds)}>
                    <Markdown
                      document={{
                        blocks: [block()],
                        footnotes:
                          index() === description().blocks.length - 1
                            ? description().footnotes
                            : undefined,
                      }}
                      compactHeadings
                    />
                  </View>
                )}
              </Each>
            </If>
            <If when={execution().length}>
              <View style={{ gap: 6 }}>
                <Caption text={uiText("draftExecution")} />
                <Each of={execution()} key={(field) => field.label}>
                  {(field) => (
                    <Field label={field().label} value={field().value} />
                  )}
                </Each>
              </View>
            </If>
            <If when={data().dependsOn?.length}>
              <View style={{ gap: 6 }}>
                <Caption text={uiText("dependencies")} />
                <Each of={data().dependsOn ?? []} key={(edge) => edge.taskId}>
                  {(edge) => (
                    <Label size={13}>
                      {taskName(edge().taskId)} ·{" "}
                      {uiText(
                        edge().requireDone
                          ? "draftRequireDone"
                          : "draftAllowReview",
                      )}
                    </Label>
                  )}
                </Each>
              </View>
            </If>
            <If when={data().parentId}>
              {(id) => (
                <Field label={uiText("draftParent")} value={taskName(id())} />
              )}
            </If>
            <Label size={13} tone="muted">
              {uiText(
                draftStatus(data()) === "backlog"
                  ? "draftToBacklog"
                  : "draftToDo",
              )}
            </Label>
          </If>
        </View>
      </Scroll>
    </Modal>
  );
}
