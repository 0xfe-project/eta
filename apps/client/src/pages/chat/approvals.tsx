import type {
  CaptainOperationView,
  InboxResponse,
  InteractionView,
} from "@eta/client-contracts";
import { Scroll, signal, View } from "nsh";
import {
  Button,
  Caption,
  colors,
  Field,
  grow,
  Icon,
  Label,
  row,
} from "../../components";
import { uiText } from "../../i18n";
import { relativeTime, useHost } from "../../services/host";

function SheetQuestion(props: {
  item: InteractionView;
  onDone?: () => void;
  onConversation?: () => void;
  sheet?: boolean;
}) {
  const host = useHost();
  const c = colors();
  const selected = signal<string[]>([]);
  const reply = signal("");
  const busy = signal(false);
  const conversation = () =>
    host.conversations().find((item) => item.id === props.item.conversationId);
  async function answer(response: InboxResponse) {
    if (busy()) return;
    busy.set(true);
    const result = await host.action(() =>
      host.call("inbox", "answer", { id: props.item.id, response }),
    );
    busy.set(false);
    if (result) props.onDone?.();
  }
  function toggle(option: string) {
    selected.update((items) =>
      items.includes(option)
        ? items.filter((item) => item !== option)
        : props.item.multi
          ? [...items, option]
          : [option],
    );
  }
  function submit() {
    return answer(
      selected().length
        ? {
            kind: "selection",
            selections: selected(),
            comment: reply().trim() || undefined,
          }
        : { kind: "freeform", text: reply().trim() },
    );
  }
  return (
    <View
      style={{
        ...(props.sheet ? grow : {}),
        borderWidth: props.sheet ? 0 : 1,
        borderColor: c().border,
        backgroundColor: c().canvas,
      }}
    >
      <Scroll style={props.sheet ? grow : undefined} scrollbar={false}>
        <View style={{ padding: props.sheet ? 16 : 12, gap: 8 }}>
          <If when={props.sheet} else={<Caption text={uiText("question")} />}>
            <Label size={11} tone="muted">
              {[conversation()?.name, relativeTime(props.item.createdAt)]
                .filter(Boolean)
                .join(" · ")}
            </Label>
          </If>
          <Label size={props.sheet ? 16 : 14}>{props.item.prompt}</Label>
          <View
            style={
              props.sheet ? { gap: 8 } : { ...row, flexWrap: "wrap", gap: 6 }
            }
          >
            <Each of={props.item.options}>
              {(option) => (
                <Button
                  label={option()}
                  selected={selected().includes(option())}
                  tone={
                    props.sheet && selected().includes(option())
                      ? "primary"
                      : "plain"
                  }
                  end={
                    props.sheet && selected().includes(option())
                      ? "check"
                      : undefined
                  }
                  size={props.sheet ? 44 : undefined}
                  labelSize={props.sheet ? 14 : undefined}
                  style={
                    props.sheet
                      ? {
                          width: "100%",
                          justifyContent: "space-between",
                          paddingHorizontal: 12,
                        }
                      : undefined
                  }
                  onPress={() => toggle(option())}
                />
              )}
            </Each>
          </View>
          <Field
            label={uiText("yourAnswer")}
            value={reply()}
            placeholder={
              props.sheet
                ? uiText("orWriteYourOwnAnswer")
                : uiText("yourAnswerProgress")
            }
            onChange={reply.set}
            style={props.sheet ? { height: 43 } : undefined}
          />
        </View>
      </Scroll>
      <View
        style={{
          ...row,
          justifyContent: "flex-end",
          gap: 8,
          padding: props.sheet ? 16 : 12,
          borderTopWidth: props.sheet ? 1 : 0,
          borderColor: c().border,
        }}
      >
        <If when={props.sheet && props.onConversation}>
          <Button
            label={uiText("openConversation")}
            tone="ghost"
            onPress={() => props.onConversation?.()}
          />
          <View style={{ flex: 1 }} />
        </If>
        <If when={!props.sheet}>
          <Button
            label={uiText("skip")}
            disabled={busy()}
            onPress={() => void answer({ kind: "none" })}
          />
        </If>
        <Button
          label={props.sheet ? uiText("sendAnswer") : uiText("answer")}
          tone="primary"
          size={props.sheet ? 36 : undefined}
          disabled={busy() || (!selected().length && !reply().trim())}
          onPress={() => void submit()}
        />
      </View>
    </View>
  );
}

function SheetProposal(props: {
  operation: CaptainOperationView;
  sheet?: boolean;
  onConversation?: () => void;
}) {
  const host = useHost();
  const c = colors();
  const working = signal(false);
  const title = () =>
    String(
      props.operation.payload.name ??
        props.operation.payload.title ??
        props.operation.kind.replaceAll("_", " "),
    );
  async function decide(decision: "approve" | "reject") {
    if (working()) return;
    working.set(true);
    await host.action(() =>
      host.call("captain", "decideOperation", {
        operationId: props.operation.id,
        decision,
      }),
    );
    working.set(false);
  }
  return (
    <View
      style={{
        ...(props.sheet ? grow : {}),
        borderWidth: props.sheet ? 0 : 1,
        borderColor: c().border,
        padding: props.sheet ? 16 : 10,
        gap: props.sheet ? 10 : 5,
      }}
    >
      <Caption text={props.operation.kind.replaceAll("_", " ")} />
      <Label weight={600} size={props.sheet ? 16 : 14}>
        {title()}
      </Label>
      <Each
        of={Object.entries(props.operation.payload).filter(
          ([key, value]) =>
            !["name", "title"].includes(key) &&
            !key.endsWith("Id") &&
            typeof value === "string",
        )}
      >
        {(detail) => (
          <Label size={12} tone="muted">
            {String(detail()[1])}
          </Label>
        )}
      </Each>
      <If
        when={
          props.operation.requiresApproval &&
          props.operation.status === "pending"
        }
        else={
          <Label size={12} tone="muted">
            {props.operation.error ?? props.operation.status}
          </Label>
        }
      >
        <If when={props.sheet}>
          <View style={{ flex: 1 }} />
        </If>
        <View style={{ ...row, justifyContent: "flex-end", gap: 6 }}>
          <If when={props.sheet && props.onConversation}>
            <Button
              label={uiText("openConversation")}
              tone="ghost"
              onPress={() => props.onConversation?.()}
            />
            <View style={{ flex: 1 }} />
          </If>
          <Button
            label={uiText("reject")}
            disabled={working()}
            onPress={() => void decide("reject")}
          />
          <Button
            label={uiText("approve")}
            tone="primary"
            disabled={working()}
            onPress={() => void decide("approve")}
          />
        </View>
      </If>
    </View>
  );
}

/** A question an agent asked: a card in the transcript, a sheet on a phone. */
export function Question(props: {
  item: InteractionView;
  onDone?: () => void;
  onConversation?: () => void;
  sheet?: boolean;
}) {
  return (
    <If when={props.sheet} else={<QuestionCard item={props.item} />}>
      <SheetQuestion {...props} />
    </If>
  );
}

function Choice(props: {
  label: string;
  selected?: boolean;
  quiet?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const c = colors();
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      accessibilityState={{
        selected: props.selected,
        disabled: props.disabled ?? false,
      }}
      onPress={() => {
        if (!props.disabled) props.onPress();
      }}
      hoverStyle={
        props.selected ? undefined : { backgroundColor: c().selected }
      }
      focusVisibleStyle={{
        outlineWidth: 1,
        outlineColor: c().blue,
        outlineOffset: 1,
      }}
      style={{
        ...row,
        height: 28,
        paddingHorizontal: 10,
        borderWidth: 1,
        borderColor: props.selected
          ? c().button
          : props.quiet
            ? c().border
            : c().strong,
        backgroundColor: props.selected ? c().button : "transparent",
        opacity: props.disabled ? 0.45 : 1,
        cursor: props.disabled ? "default" : "pointer",
      }}
    >
      <Label
        size={11}
        line={14}
        tone={props.selected ? "buttonInk" : props.quiet ? "muted" : "ink"}
        style={{ letterSpacing: 0.9, textTransform: "uppercase" }}
      >
        {props.label}
      </Label>
    </View>
  );
}

function QuestionCard(props: { item: InteractionView }) {
  const host = useHost();
  const c = colors();
  const selected = signal<string[]>([]);
  const reply = signal("");
  const busy = signal(false);
  const freeform = () => !props.item.options.length;
  const name = () => host.agent(props.item.agentId)?.name ?? uiText("agent");
  async function answer(response: InboxResponse) {
    if (busy()) return;
    busy.set(true);
    await host.action(() =>
      host.call("inbox", "answer", { id: props.item.id, response }),
    );
    busy.set(false);
  }
  function choose(option: string) {
    // One choice answers at once; several are sent together.
    if (!props.item.multi) {
      void answer({ kind: "selection", selections: [option] });
      return;
    }
    selected.update((items) =>
      items.includes(option)
        ? items.filter((item) => item !== option)
        : [...items, option],
    );
  }
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: c().amber,
        backgroundColor: c().canvas,
      }}
    >
      <View
        style={{
          ...row,
          gap: 8,
          paddingVertical: 4,
          paddingHorizontal: 10,
          backgroundColor: `${c().ink}08`,
          borderBottomWidth: 1,
          borderColor: c().border,
        }}
      >
        <Label
          size={10}
          line={14}
          tone="amber"
          style={{ letterSpacing: 1.4, textTransform: "uppercase" }}
        >
          {uiText("confirmationRequestCaption")}
        </Label>
        <Label
          size={10}
          line={14}
          lines={1}
          style={{ letterSpacing: 1.4, textTransform: "uppercase" }}
        >
          {name()}
        </Label>
      </View>
      <Label line={23} style={{ paddingVertical: 8, paddingHorizontal: 10 }}>
        {props.item.prompt}
      </Label>
      <View
        style={{
          ...row,
          flexWrap: "wrap",
          gap: 6,
          paddingHorizontal: 10,
          paddingBottom: 10,
        }}
      >
        <If when={freeform()}>
          <Field
            label={uiText("yourAnswer")}
            value={reply()}
            onChange={reply.set}
            onSubmit={() => {
              if (reply().trim())
                void answer({ kind: "freeform", text: reply().trim() });
            }}
            style={{
              width: 400,
              maxWidth: "100%",
              height: 28,
              fontSize: 12,
              lineHeight: 16,
            }}
          />
        </If>
        <Each of={props.item.options}>
          {(option) => (
            <Choice
              label={option()}
              selected={selected().includes(option())}
              disabled={busy()}
              onPress={() => choose(option())}
            />
          )}
        </Each>
        <If when={props.item.multi || freeform()}>
          <Choice
            label={uiText("send")}
            disabled={
              busy() || (freeform() ? !reply().trim() : !selected().length)
            }
            onPress={() =>
              void answer(
                freeform()
                  ? { kind: "freeform", text: reply().trim() }
                  : { kind: "selection", selections: selected() },
              )
            }
          />
        </If>
        <Choice
          label={uiText("giveUp")}
          quiet
          disabled={busy()}
          onPress={() => void answer({ kind: "none" })}
        />
      </View>
    </View>
  );
}

/** The questions waiting in a conversation, above its transcript. */
export function PendingStrip(props: { items: InteractionView[] }) {
  const host = useHost();
  const c = colors();
  const first = () => props.items[0];
  return (
    <If when={first()}>
      {(item) => (
        <View
          style={{
            gap: 2,
            paddingVertical: 4,
            paddingHorizontal: 8,
            borderWidth: 1,
            borderColor: c().amber,
            backgroundColor: c().canvas,
          }}
        >
          <View style={{ ...row, gap: 8, paddingVertical: 2 }}>
            <Label
              size={10}
              line={14}
              tone="amber"
              style={{ letterSpacing: 0.8, textTransform: "uppercase" }}
            >
              {host.agent(item().agentId)?.name ?? uiText("agent")}
            </Label>
            <Label size={11} line={16} lines={1} style={{ flex: 1 }}>
              {item().prompt}
            </Label>
          </View>
          <If when={props.items.length > 1}>
            <Label size={10} line={14} tone="muted">
              {uiText("moreWaiting", { count: props.items.length - 1 })}
            </Label>
          </If>
        </View>
      )}
    </If>
  );
}

const proposalKinds: Record<string, Parameters<typeof uiText>[0]> = {
  create_group: "proposalNewGroup",
  create_agent: "proposalNewAgent",
  create_routine: "proposalNewRoutine",
};

/** A change Captain proposed: a card in the transcript, a sheet on a phone. */
export function Proposal(props: {
  operation: CaptainOperationView;
  sheet?: boolean;
  onConversation?: () => void;
}) {
  return (
    <If when={props.sheet} else={<ProposalCard operation={props.operation} />}>
      <SheetProposal {...props} />
    </If>
  );
}

function ProposalCard(props: { operation: CaptainOperationView }) {
  const host = useHost();
  const c = colors();
  const working = signal(false);
  const op = () => props.operation;
  const pending = () => op().requiresApproval && op().status === "pending";
  const open = signal<boolean | undefined>(undefined);
  const expanded = () => open() ?? pending();
  const payload = () => op().payload;
  const text = (key: string) =>
    typeof payload()[key] === "string" ? (payload()[key] as string) : "";
  const names = (ids: unknown) =>
    Array.isArray(ids)
      ? ids
          .map((id) => host.agent(String(id))?.name)
          .filter(Boolean)
          .join(", ")
      : "";
  const title = () =>
    text("name") || text("title") || op().kind.replaceAll("_", " ");
  const fields = (): [Parameters<typeof uiText>[0], string][] => {
    switch (op().kind) {
      case "create_group":
        return [
          ["proposalDirectory", text("path") || text("projectName")],
          ["proposalMembers", names(payload().memberIds)],
          ["proposalSteward", names([payload().stewardId])],
          ["proposalGoal", text("goal")],
        ];
      case "create_agent":
        return [
          ["proposalPurpose", text("purpose")],
          ["proposalPersona", text("persona")],
          ["proposalModel", text("model")],
          ["proposalRuntime", text("runtime")],
        ];
      case "create_routine":
        return [
          ["proposalWhen", text("scheduleText")],
          ["proposalBrief", text("brief")],
        ];
      default:
        return [];
    }
  };
  const badge = (): [
    Parameters<typeof uiText>[0],
    "ink" | "green" | "muted",
  ] => {
    switch (op().status) {
      case "pending":
        return ["proposalAwaiting", "ink"];
      case "applied":
        return ["proposalCreated", "green"];
      case "rejected":
        return ["proposalRejected", "muted"];
      case "failed":
        return ["proposalFailed", "ink"];
      case "expired":
        return ["proposalExpired", "muted"];
      default:
        return ["proposalApproved", "muted"];
    }
  };
  const result = () =>
    op().status === "failed"
      ? (op().error ?? "")
      : op().status === "applied" && op().kind === "create_agent"
        ? uiText("proposalAgentReady", { name: title() })
        : "";
  async function decide(decision: "approve" | "reject") {
    if (working()) return;
    working.set(true);
    await host.action(() =>
      host.call("captain", "decideOperation", {
        operationId: op().id,
        decision,
      }),
    );
    working.set(false);
  }
  return (
    <View style={{ borderWidth: 1, borderColor: c().border }}>
      <View
        role="button"
        accessibilityLabel={title()}
        accessibilityState={{ expanded: expanded() }}
        onPress={() => open.set(!expanded())}
        style={{
          ...row,
          height: 30,
          gap: 6,
          paddingHorizontal: 8,
          cursor: "pointer",
        }}
      >
        <Icon name={expanded() ? "down" : "right"} size={8} tone="muted" />
        <Label
          size={10}
          line={12}
          tone="muted"
          style={{ letterSpacing: 0.8, textTransform: "uppercase" }}
        >
          {proposalKinds[op().kind]
            ? uiText(proposalKinds[op().kind]!)
            : op().kind.replaceAll("_", " ")}
        </Label>
        <Label size={12} line={16} weight={600} lines={1} style={{ flex: 1 }}>
          {title()}
        </Label>
        <View
          style={{
            paddingHorizontal: pending() ? 5 : 0,
            borderWidth: pending() ? 1 : 0,
            borderColor: c().strong,
            flexShrink: 0,
          }}
        >
          <Label size={10} line={12} tone={badge()[1]}>
            {`■ ${uiText(badge()[0])}`}
          </Label>
        </View>
      </View>
      <If when={expanded() && pending()}>
        <View
          style={{
            padding: 10,
            gap: 6,
            borderTopWidth: 1,
            borderColor: c().border,
          }}
        >
          <Each of={fields().filter(([, value]) => value)}>
            {(field) => (
              <View style={{ ...row, alignItems: "flex-start", gap: 8 }}>
                <Label
                  size={10}
                  line={12}
                  tone="muted"
                  style={{
                    width: 72,
                    flexShrink: 0,
                    letterSpacing: 0.8,
                    textTransform: "uppercase",
                  }}
                >
                  {uiText(field()[0])}
                </Label>
                <Label size={12} line={16} style={{ flex: 1 }}>
                  {field()[1]}
                </Label>
              </View>
            )}
          </Each>
          <View style={{ ...row, gap: 8, paddingTop: 4 }}>
            <Button
              label={uiText("proposalCreate")}
              tone="primary"
              size={22}
              labelSize={11}
              style={{ paddingHorizontal: 10 }}
              disabled={working()}
              onPress={() => void decide("approve")}
            />
            <View
              role="button"
              accessibilityLabel={uiText("reject")}
              onPress={() => {
                if (!working()) void decide("reject");
              }}
              hoverStyle={{ backgroundColor: c().selected }}
              style={{
                ...row,
                height: 22,
                paddingHorizontal: 10,
                cursor: "pointer",
              }}
            >
              <Label size={11} line={14} tone="muted">
                {uiText("reject")}
              </Label>
            </View>
          </View>
        </View>
      </If>
      <If when={expanded() && !pending() && result()}>
        <Label
          size={12}
          line={16}
          tone={op().status === "failed" ? "mutedInk" : "ink"}
          style={{
            paddingVertical: 8,
            paddingHorizontal: 10,
            borderTopWidth: 1,
            borderColor: c().border,
          }}
        >
          {result()}
        </Label>
      </If>
    </View>
  );
}
