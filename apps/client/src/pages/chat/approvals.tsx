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
  focusRing,
  grow,
  Icon,
  Label,
  row,
  SmoothScroll,
  textFaces,
  textStyle,
} from "../../components";
import { shownWhile } from "../../components/pending";
import { Spinner } from "../../components/spinner";
import { StatusDot } from "../../components/status-dot";
import { control, icon, opacity, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { relativeTime, useHost } from "../../services/host";

/** A free answer's field; a proposal card's header and its fields' label column. */
const answerWidth = 400;
const cardHeaderHeight = 32;
const fieldLabelWidth = 72;

/** The strip above the transcript naming a question waiting off screen. */
export const pendingStripHeight = 32;

function SheetQuestion(props: {
  item: InteractionView;
  onDone?: () => void;
  onConversation?: () => void;
  /** Takes the user to where the question came from; absent when there is no such place. */
  onSource?: () => void;
  sheet?: boolean;
}) {
  const host = useHost();
  const c = colors();
  const selected = signal<string[]>([]);
  const reply = signal("");
  /** Which answer is on its way: skipping, or the answer. */
  const busy = signal<"" | "skip" | "answer">("");
  const conversation = () => host.conversation(props.item.conversationId);
  async function answer(response: InboxResponse) {
    if (busy()) return;
    busy.set(response.kind === "none" ? "skip" : "answer");
    const result = await host.action(() =>
      host.call("inbox", "answer", { id: props.item.id, response }),
    );
    busy.set("");
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
              ? {
                  paddingTop: space[4],
                  paddingHorizontal: space[16],
                  gap: space[12],
                }
              : { padding: space[12], gap: space[8] }
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
          <If when={props.item.context}>
            {(text) => (
              <Label variant="small" tone="muted">
                {text()}
              </Label>
            )}
          </If>
          <View
            style={
              props.sheet
                ? { gap: space[8] }
                : { ...row, flexWrap: "wrap", gap: space[4] }
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
                  size={props.sheet ? control.touch : undefined}
                  style={
                    props.sheet
                      ? {
                          width: "100%",
                          justifyContent: "space-between",
                          paddingHorizontal: space[12],
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
                    height: control.touch,
                    paddingHorizontal: space[12],
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
          gap: space[8],
          ...(props.sheet
            ? { height: space[64], paddingHorizontal: space[16], flexShrink: 0 }
            : { padding: space[12] }),
          borderTopWidth: props.sheet ? 1 : 0,
          borderColor: c().border,
        }}
      >
        <If when={props.sheet}>
          <View style={{ ...row, flex: 1, gap: space[16] }}>
            <If when={props.onConversation}>
              <View
                role="button"
                accessibilityLabel={uiText("openConversation")}
                onPress={() => props.onConversation?.()}
                style={{ cursor: "pointer" }}
              >
                <Label variant="small" tone="muted">
                  {uiText("openConversation")}
                </Label>
              </View>
            </If>
            <If when={props.onSource}>
              <View
                role="button"
                accessibilityLabel={uiText("jumpToSource")}
                onPress={() => props.onSource?.()}
                style={{ cursor: "pointer" }}
              >
                <Label variant="small" tone="muted">
                  {uiText("jumpToSource")}
                </Label>
              </View>
            </If>
          </View>
        </If>
        <If when={!props.sheet}>
          <Button
            label={uiText("skip")}
            disabled={busy() === "answer"}
            busy={busy() === "skip"}
            onPress={() => void answer({ kind: "none" })}
          />
        </If>
        <Button
          label={props.sheet ? uiText("sendAnswer") : uiText("answer")}
          tone="primary"
          size={props.sheet ? control.touch : undefined}
          labelWeight={props.sheet ? weight.strong : undefined}
          style={props.sheet ? { paddingHorizontal: space[16] } : undefined}
          disabled={
            busy() === "skip" || (!selected().length && !reply().trim())
          }
          busy={busy() === "answer"}
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
  /** The decision on its way. */
  const working = signal<false | "approve" | "reject">(false);
  const op = () => props.operation;
  const pending = () => op().requiresApproval && op().status === "pending";
  const title = () =>
    String(op().payload.name ?? op().payload.title ?? kindName(op().kind));
  const conversation = () =>
    host.conversation(op().payload.originConversationId as string | undefined);
  async function decide(decision: "approve" | "reject") {
    if (working()) return;
    working.set(decision);
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
        <View
          style={{
            paddingTop: space[4],
            paddingHorizontal: space[16],
            gap: space[12],
          }}
        >
          <View style={{ gap: space[4] }}>
            <Caption
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
              <View style={{ gap: space[4] }}>
                <Caption text={uiText(field()[0])} />
                <Label variant="small">{field()[1]}</Label>
              </View>
            )}
          </Each>
          <If
            when={pending()}
            else={
              <Label
                variant="small"
                tone={op().status === "failed" ? "red" : "muted"}
              >
                {op().status === "failed"
                  ? op().error?.trim() || uiText("proposalFailed")
                  : uiText(proposalStatusBadge(op().status)[0])}
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
            height: space[64],
            flexShrink: 0,
            gap: space[8],
            paddingHorizontal: space[16],
            borderTopWidth: 1,
            borderColor: c().border,
          }}
        >
          <Button
            label={uiText("reject")}
            size={control.touch}
            style={{ paddingHorizontal: space[16] }}
            disabled={working() === "approve"}
            busy={working() === "reject"}
            onPress={() => void decide("reject")}
          />
          <View style={{ flex: 1 }} />
          <Button
            label={uiText("proposalCreate")}
            tone="primary"
            size={control.touch}
            labelWeight={weight.strong}
            style={{ paddingHorizontal: space[20] }}
            disabled={working() === "reject"}
            busy={working() === "approve"}
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

function proposalStatusBadge(
  status: CaptainOperationView["status"],
): [Parameters<typeof uiText>[0], "ink" | "green" | "muted" | "red"] {
  switch (status) {
    case "pending":
      return ["proposalAwaiting", "ink"];
    case "applied":
      return ["proposalCreated", "green"];
    case "rejected":
      return ["proposalRejected", "muted"];
    case "failed":
      return ["proposalFailed", "red"];
    case "expired":
      return ["proposalExpired", "muted"];
    default:
      return ["proposalApproved", "muted"];
  }
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
        ...(typeof payload.runtime === "string" &&
        payload.runtime !== "" &&
        payload.runtime !== "eta"
          ? []
          : ([["proposalPersona", text("persona")]] satisfies [
              Parameters<typeof uiText>[0],
              string,
            ][])),
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
  onSource?: () => void;
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
  busy?: boolean;
  onPress: () => void;
}) {
  const c = colors();
  const waiting = shownWhile(() => !!props.busy);
  const tone = () =>
    props.selected ? "buttonInk" : props.quiet ? "muted" : "ink";
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      accessibilityState={{
        selected: props.selected,
        disabled: props.disabled ?? false,
        busy: props.busy ?? false,
      }}
      onPress={() => {
        if (!props.disabled && !props.busy) props.onPress();
      }}
      hoverStyle={
        props.selected ? undefined : { backgroundColor: c().selected }
      }
      focusVisibleStyle={focusRing(c())}
      style={{
        ...row,
        justifyContent: "center",
        height: control.md,
        paddingHorizontal: space[12],
        borderWidth: 1,
        borderColor: props.selected
          ? c().button
          : props.quiet
            ? c().border
            : c().strong,
        backgroundColor: props.selected ? c().button : "transparent",
        opacity: props.disabled ? opacity.disabled : 1,
        cursor: props.disabled ? "default" : "pointer",
      }}
    >
      <Label
        tracking="caps"
        variant="caption"
        tone={tone()}
        style={{ textTransform: "uppercase", opacity: waiting() ? 0 : 1 }}
      >
        {props.label}
      </Label>
      <If when={waiting()}>
        <View
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Spinner size={icon.sm} tone={tone()} />
        </View>
      </If>
    </View>
  );
}

/** The question a jump went to, its card lit up for a moment. */
const flashing = signal("");
let flashTimer: ReturnType<typeof setTimeout> | undefined;

/** Lights up the card of question `id` for a moment, after a jump to it. */
export function flashQuestion(id: string) {
  clearTimeout(flashTimer);
  flashing.set(id);
  flashTimer = setTimeout(() => flashing.set(""), 1200);
}

function QuestionCard(props: { item: InteractionView }) {
  const host = useHost();
  const c = colors();
  const type = textFaces();
  const selected = signal<string[]>([]);
  const reply = signal("");
  const busyKey = signal("");
  const busy = () => !!busyKey();
  const freeform = () => !props.item.options.length;
  const name = () => host.agent(props.item.agentId)?.name ?? uiText("agent");
  async function answer(response: InboxResponse, key: string) {
    if (busy()) return;
    busyKey.set(key);
    await host.action(() =>
      host.call("inbox", "answer", { id: props.item.id, response }),
    );
    busyKey.set("");
  }
  function choose(option: string) {
    // One choice answers at once; several are sent together.
    if (!props.item.multi) {
      void answer({ kind: "selection", selections: [option] }, `opt:${option}`);
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
      testID={`question-${props.item.id}`}
      style={{
        borderWidth: 1,
        borderColor: c().strong,
        // A jump from the strip above the transcript lights the card up for a moment.
        backgroundColor:
          flashing() === props.item.id ? c().warningFill : c().canvas,
        transitionProperty: "backgroundColor",
        transitionDuration: flashing() === props.item.id ? 0 : 900,
      }}
    >
      <View
        style={{
          ...row,
          gap: space[8],
          paddingVertical: space[4],
          paddingHorizontal: space[12],
          backgroundColor: c().overlay,
          borderBottomWidth: 1,
          borderColor: c().border,
        }}
      >
        <Label
          tracking="caps"
          variant="caption"
          tone="warning"
          style={{ textTransform: "uppercase" }}
        >
          {uiText("confirmationRequestCaption")}
        </Label>
        <Label
          tracking="caps"
          variant="caption"
          lines={1}
          style={{ textTransform: "uppercase" }}
        >
          {name()}
        </Label>
      </View>
      <Label
        style={{ paddingVertical: space[8], paddingHorizontal: space[12] }}
      >
        {props.item.prompt}
      </Label>
      <If when={props.item.context}>
        {(text) => (
          <Label
            variant="small"
            tone="muted"
            style={{ paddingHorizontal: space[12], paddingBottom: space[8] }}
          >
            {text()}
          </Label>
        )}
      </If>
      <View
        style={{
          ...row,
          flexWrap: "wrap",
          gap: space[4],
          paddingHorizontal: space[12],
          paddingBottom: space[12],
        }}
      >
        <If when={freeform()}>
          <Field
            label={uiText("yourAnswer")}
            value={reply()}
            onChange={reply.set}
            onSubmit={() => {
              if (reply().trim())
                void answer({ kind: "freeform", text: reply().trim() }, "send");
            }}
            style={{
              width: answerWidth,
              maxWidth: "100%",
              height: control.md,
              ...textStyle(type("small")),
            }}
          />
        </If>
        <Each of={props.item.options}>
          {(option) => (
            <Choice
              label={option()}
              selected={selected().includes(option())}
              disabled={busy() && busyKey() !== `opt:${option()}`}
              busy={busyKey() === `opt:${option()}`}
              onPress={() => choose(option())}
            />
          )}
        </Each>
        <If when={props.item.multi || freeform()}>
          <Choice
            label={uiText("send")}
            disabled={
              (busy() && busyKey() !== "send") ||
              (freeform() ? !reply().trim() : !selected().length)
            }
            busy={busyKey() === "send"}
            onPress={() =>
              void answer(
                freeform()
                  ? { kind: "freeform", text: reply().trim() }
                  : { kind: "selection", selections: selected() },
                "send",
              )
            }
          />
        </If>
        <Choice
          label={uiText("giveUp")}
          quiet
          disabled={busy() && busyKey() !== "none"}
          busy={busyKey() === "none"}
          onPress={() => void answer({ kind: "none" }, "none")}
        />
      </View>
    </View>
  );
}

/** A question waiting off screen, above the transcript: pressing it goes to the question. */
export function PendingStrip(props: {
  item: InteractionView;
  /** How many other questions wait in the conversation. */
  more: number;
  onJump: (item: InteractionView) => void;
}) {
  const host = useHost();
  const c = colors();
  const text = () =>
    uiText("waitingForYourAnswer", {
      name: host.agent(props.item.agentId)?.name ?? uiText("agent"),
      prompt: props.item.prompt,
    });
  return (
    <View
      role="button"
      accessibilityLabel={uiText("jumpToQuestion")}
      accessibilityHint={text()}
      onPress={() => props.onJump(props.item)}
      hoverStyle={{ backgroundColor: c().selected }}
      focusVisibleStyle={focusRing(c())}
      style={{
        ...row,
        height: pendingStripHeight,
        gap: space[8],
        paddingHorizontal: space[12],
        borderWidth: 1,
        borderColor: c().strong,
        backgroundColor: c().canvas,
        cursor: "pointer",
      }}
    >
      <StatusDot color={c().warning} />
      <Label variant="small" lines={1} style={{ flex: 1 }}>
        {text()}
      </Label>
      <If when={props.more > 0}>
        <Label variant="caption" tone="muted" style={{ flexShrink: 0 }}>
          {uiText("moreQuestions", { count: props.more })}
        </Label>
      </If>
      <Label variant="caption" tone="muted" style={{ flexShrink: 0 }}>
        {uiText("jumpToQuestion")}
      </Label>
    </View>
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
  const working = signal<false | "approve" | "reject">(false);
  const op = () => props.operation;
  const pending = () => op().requiresApproval && op().status === "pending";
  const failed = () => op().status === "failed";
  const open = signal<boolean | undefined>(undefined);
  const expanded = () => open() ?? (pending() || failed());
  const payload = () => op().payload;
  const text = (key: string) =>
    typeof payload()[key] === "string" ? (payload()[key] as string) : "";
  const title = () =>
    text("name") || text("title") || op().kind.replaceAll("_", " ");
  const fields = () => proposalFields(op(), host);
  const shownFields = () => fields().filter(([, value]) => value);
  const badge = () => proposalStatusBadge(op().status);
  const result = () =>
    failed()
      ? (op().error?.trim() ?? "")
      : op().status === "applied" && op().kind === "create_agent"
        ? uiText("proposalAgentReady", { name: title() })
        : "";
  const hasBody = () =>
    shownFields().length > 0 || pending() || Boolean(result());
  async function decide(decision: "approve" | "reject") {
    if (working()) return;
    working.set(decision);
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
          height: cardHeaderHeight,
          gap: space[4],
          paddingHorizontal: space[8],
          cursor: "pointer",
        }}
      >
        <Icon
          name={expanded() ? "down" : "right"}
          size={icon.sm}
          tone="muted"
        />
        <Label
          tracking="caps"
          variant="caption"
          tone="muted"
          style={{ textTransform: "uppercase" }}
        >
          {kindName(op().kind)}
        </Label>
        <Label
          variant="small"
          weight={weight.strong}
          lines={1}
          style={{ flex: 1 }}
        >
          {title()}
        </Label>
        <View
          style={{
            paddingHorizontal: pending() ? space[4] : 0,
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
      <If when={expanded() && hasBody()}>
        <View
          style={{
            padding: space[12],
            gap: space[4],
            borderTopWidth: 1,
            borderColor: c().border,
          }}
        >
          <Each of={shownFields()}>
            {(field) => (
              <View style={{ ...row, alignItems: "flex-start", gap: space[8] }}>
                <Label
                  tracking="caps"
                  variant="caption"
                  tone="muted"
                  style={{
                    width: fieldLabelWidth,
                    flexShrink: 0,
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
          <If when={pending()}>
            <View style={{ ...row, gap: space[8], paddingTop: space[4] }}>
              <Button
                label={uiText("proposalCreate")}
                tone="primary"
                size={control.sm}
                labelVariant="caption"
                style={{ paddingHorizontal: space[12] }}
                disabled={working() === "reject"}
                busy={working() === "approve"}
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
                  height: control.sm,
                  paddingHorizontal: space[12],
                  cursor: "pointer",
                }}
              >
                <Label variant="caption" tone="muted">
                  {uiText("reject")}
                </Label>
              </View>
            </View>
          </If>
          <If when={!pending() && result()}>
            <View
              role={failed() ? "alert" : undefined}
              style={
                shownFields().length
                  ? {
                      paddingTop: space[8],
                      borderTopWidth: 1,
                      borderColor: c().border,
                    }
                  : undefined
              }
            >
              <Label variant="small" tone={failed() ? "red" : "ink"}>
                {result()}
              </Label>
            </View>
          </If>
        </View>
      </If>
    </View>
  );
}
