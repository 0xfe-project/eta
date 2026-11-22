import type {
  CaptainOperationView,
  InboxResponse,
  InteractionView,
} from "@eta/client-contracts";
import { signal, View } from "nsh";
import {
  Button,
  Caption,
  colors,
  Field,
  grow,
  Icon,
  Label,
  row,
  SmoothScroll,
  textFaces,
  textStyle,
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
      <SmoothScroll style={props.sheet ? grow : undefined} scrollbar={false}>
        <View
          style={
            props.sheet
              ? { paddingTop: 4, paddingHorizontal: 16, gap: 12 }
              : { padding: 12, gap: 8 }
          }
        >
          <If when={props.sheet} else={<Caption text={uiText("question")} />}>
            <Label variant="caption" tone="muted">
              {[conversation()?.name, relativeTime(props.item.createdAt)]
                .filter(Boolean)
                .join(" · ")}
            </Label>
          </If>
          <Label>{props.item.prompt}</Label>
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
            style={
              props.sheet
                ? {
                    height: 44,
                    paddingHorizontal: 12,
                  }
                : undefined
            }
          />
        </View>
      </SmoothScroll>
      <View
        style={{
          ...row,
          justifyContent: "flex-end",
          gap: 8,
          ...(props.sheet
            ? { height: 64, paddingHorizontal: 16, flexShrink: 0 }
            : { padding: 12 }),
          borderTopWidth: props.sheet ? 1 : 0,
          borderColor: c().border,
        }}
      >
        <If when={props.sheet}>
          <View
            role={props.onConversation ? "button" : undefined}
            accessibilityLabel={uiText("openConversation")}
            onPress={() => props.onConversation?.()}
            style={{
              flex: 1,
              cursor: props.onConversation ? "pointer" : "default",
            }}
          >
            <If when={props.onConversation}>
              <Label variant="small" tone="muted">
                {uiText("openConversation")}
              </Label>
            </If>
          </View>
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
          labelWeight={props.sheet ? 600 : undefined}
          style={props.sheet ? { paddingHorizontal: 16 } : undefined}
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
  const op = () => props.operation;
  const pending = () => op().requiresApproval && op().status === "pending";
  const title = () =>
    String(op().payload.name ?? op().payload.title ?? kindName(op().kind));
  const conversation = () =>
    host
      .conversations()
      .find((item) => item.id === op().payload.originConversationId);
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
    <View style={grow}>
      <SmoothScroll style={grow} scrollbar={false}>
        <View style={{ paddingTop: 4, paddingHorizontal: 16, gap: 14 }}>
          <View style={{ gap: 4 }}>
            <Caption
              phone
              text={[
                kindName(op().kind),
                conversation()?.name,
                relativeTime(op().createdAt),
              ]
                .filter(Boolean)
                .join(" · ")}
            />
            <Label variant="subtitle">{title()}</Label>
          </View>
          <Each of={proposalFields(op(), host).filter(([, value]) => value)}>
            {(field) => (
              <View style={{ gap: 4 }}>
                <Caption phone text={uiText(field()[0])} />
                <Label variant="small">{field()[1]}</Label>
              </View>
            )}
          </Each>
          <If
            when={pending()}
            else={
              <Label variant="small" tone="muted">
                {op().error ?? op().status}
              </Label>
            }
          >
            <If when={props.onConversation}>
              <View
                role="button"
                accessibilityLabel={uiText("openConversation")}
                onPress={() => props.onConversation?.()}
                style={{ cursor: "pointer" }}
              >
                <Label variant="small" tone="muted">
                  {uiText("proposalSeeConversation")}
                </Label>
              </View>
            </If>
          </If>
        </View>
      </SmoothScroll>
      <If when={pending()}>
        <View
          style={{
            ...row,
            height: 64,
            flexShrink: 0,
            gap: 8,
            paddingHorizontal: 16,
            borderTopWidth: 1,
            borderColor: c().border,
          }}
        >
          <Button
            label={uiText("reject")}
            size={36}
            style={{ paddingHorizontal: 16 }}
            disabled={working()}
            onPress={() => void decide("reject")}
          />
          <View style={{ flex: 1 }} />
          <Button
            label={uiText("proposalCreate")}
            tone="primary"
            size={36}
            labelWeight={600}
            style={{ paddingHorizontal: 20 }}
            disabled={working()}
            onPress={() => void decide("approve")}
          />
        </View>
      </If>
    </View>
  );
}

const proposalKinds: Record<string, Parameters<typeof uiText>[0]> = {
  create_group: "proposalNewGroup",
  create_agent: "proposalNewAgent",
  create_routine: "proposalNewRoutine",
};

function kindName(kind: string) {
  return proposalKinds[kind]
    ? uiText(proposalKinds[kind]!)
    : kind.replaceAll("_", " ");
}

/** What a proposal of each kind will make, as label and value pairs. */
function proposalFields(
  op: CaptainOperationView,
  host: ReturnType<typeof useHost>,
): [Parameters<typeof uiText>[0], string][] {
  const payload = op.payload;
  const text = (key: string) =>
    typeof payload[key] === "string" ? (payload[key] as string) : "";
  const names = (ids: unknown) =>
    Array.isArray(ids)
      ? ids
          .map((id) => host.agent(String(id))?.name)
          .filter(Boolean)
          .join(", ")
      : "";
  switch (op.kind) {
    case "create_group":
      return [
        ["proposalDirectory", text("path") || text("projectName")],
        ["proposalMembers", names(payload.memberIds)],
        ["proposalSteward", names([payload.stewardId])],
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
        variant="caption"
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
  const type = textFaces();
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
          variant="caption"
          tone="amber"
          style={{ letterSpacing: 1.4, textTransform: "uppercase" }}
        >
          {uiText("confirmationRequestCaption")}
        </Label>
        <Label
          variant="caption"
          lines={1}
          style={{ letterSpacing: 1.4, textTransform: "uppercase" }}
        >
          {name()}
        </Label>
      </View>
      <Label style={{ paddingVertical: 8, paddingHorizontal: 10 }}>
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
              ...textStyle(type("small")),
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
              variant="caption"
              tone="amber"
              style={{ letterSpacing: 0.8, textTransform: "uppercase" }}
            >
              {host.agent(item().agentId)?.name ?? uiText("agent")}
            </Label>
            <Label variant="small" lines={1} style={{ flex: 1 }}>
              {item().prompt}
            </Label>
          </View>
          <If when={props.items.length > 1}>
            <Label variant="caption" tone="muted">
              {uiText("moreWaiting", { count: props.items.length - 1 })}
            </Label>
          </If>
        </View>
      )}
    </If>
  );
}

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
  const title = () =>
    text("name") || text("title") || op().kind.replaceAll("_", " ");
  const fields = () => proposalFields(op(), host);
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
          variant="caption"
          tone="muted"
          style={{ letterSpacing: 0.8, textTransform: "uppercase" }}
        >
          {kindName(op().kind)}
        </Label>
        <Label variant="small" weight={600} lines={1} style={{ flex: 1 }}>
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
          <Label variant="caption" tone={badge()[1]}>
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
                  variant="caption"
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
                <Label variant="small" style={{ flex: 1 }}>
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
              labelVariant="caption"
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
              <Label variant="caption" tone="muted">
                {uiText("reject")}
              </Label>
            </View>
          </View>
        </View>
      </If>
      <If when={expanded() && !pending() && result()}>
        <Label
          variant="small"
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
