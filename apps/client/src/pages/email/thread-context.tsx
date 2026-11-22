import type {
  EmailAssignmentView,
  EmailMessageView,
  EmailMetaView,
  EmailResults,
  TranscriptSection,
  ViewCore,
} from "@eta/client-contracts";
import { runBlocks } from "@eta/client-contracts";
import { signal, View } from "nsh";
import {
  Button,
  colors,
  grow,
  Icon,
  Label,
  Markdown,
  Modal,
  row,
  SmoothScroll,
  textFaces,
} from "../../components";
import { AgentFace } from "../../components/agent-face";
import { LayoutSelect } from "../../components/select";
import { uiText } from "../../i18n";
import { follow, useHost } from "../../services/host";

export function EmailInfo(props: {
  label: string;
  value?: string | null;
  phoneRow?: boolean;
  compact?: boolean;
  agentId?: string;
}) {
  const c = colors();
  return (
    <If when={props.value}>
      <View
        style={{
          ...row,
          minHeight: props.phoneRow ? 48 : 42,
          gap: 12,
          borderTopWidth: props.phoneRow ? 1 : 0,
          borderBottomWidth: props.phoneRow ? 0 : 1,
          borderColor: c().border,
        }}
      >
        <Label
          variant="small"
          tone="muted"
          style={{ width: 88, flexShrink: 0 }}
        >
          {props.label}
        </Label>
        <If when={props.agentId && props.phoneRow}>
          <AgentFace id={props.agentId} size={20} />
        </If>
        <Label
          variant="small"
          tone={props.phoneRow && props.compact ? "mutedInk" : "ink"}
          weight={props.phoneRow && props.agentId ? 600 : undefined}
          style={{ flex: 1, minWidth: 0 }}
        >
          {props.value}
        </Label>
      </View>
    </If>
  );
}

function signatureText(meta: EmailMetaView) {
  return meta.signatureValid === true
    ? uiText("signatureVerified")
    : meta.signatureValid === false
      ? uiText("signatureInvalid")
      : meta.signaturePresent
        ? uiText("signatureUnchecked")
        : uiText("unsigned");
}

function dataPoints(count: number) {
  return uiText(count === 1 ? "dataPoint" : "dataPointCount", { count });
}

function entries(count: number) {
  return uiText(count === 1 ? "entry" : "entries", { count });
}

function MetaStat(props: {
  label: string;
  value: string;
  verified?: boolean;
  half?: boolean;
}) {
  const c = colors();
  return (
    <View
      style={{
        ...(props.half ? { width: "50%" } : { flex: 1 }),
        minWidth: 0,
        gap: 2,
        paddingVertical: 8,
        paddingHorizontal: 10,
        borderBottomWidth: 1,
        borderRightWidth: 1,
        borderColor: c().border,
      }}
    >
      <Label
        variant="caption"
        tone="muted"
        style={{ letterSpacing: 0.5, textTransform: "uppercase" }}
      >
        {props.label}
      </Label>
      <Label variant="small" tone={props.verified ? "green" : "ink"} lines={1}>
        {props.value}
      </Label>
    </View>
  );
}

function shown(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "✓" : "—";
  if (typeof value === "string") return value || "—";
  if (typeof value === "number") return String(value);
  return "";
}

/** One line for a payload value: a short list, an object's keys, or text. */
function summarize(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "—";
    if (value.every((item) => typeof item !== "object" || item === null)) {
      const visible = value.slice(0, 5).map(shown).join(" · ");
      return value.length > 5 ? `${visible} …` : visible;
    }
    return `${value.length} ×`;
  }
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value);
    return keys.length === 0 ? "—" : keys.slice(0, 5).join(" · ");
  }
  const text = shown(value).replace(/\s+/g, " ").trim();
  return text.length > 180 ? `${text.slice(0, 177)}…` : text;
}

/** The payload's top-level entries, the card's additional business context. */
function payloadEntries(value: unknown): [string, string][] {
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((item, index) => [String(index + 1), item])
    : typeof value === "object" && value !== null
      ? Object.entries(value)
      : [];
  return entries.map(([key, item]) => [key, summarize(item)]);
}

/** A labelled row in the context table: 10pt muted name, 11pt value. */
function ContextRow(props: {
  label: string;
  value: string;
  labelWidth: number;
  last?: boolean;
}) {
  const c = colors();
  return (
    <View
      style={{
        flexDirection: "row",
        gap: 12,
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderBottomWidth: props.last ? 0 : 1,
        borderColor: c().border,
      }}
    >
      <Label
        variant="caption"
        tone="muted"
        style={{ width: props.labelWidth, flexShrink: 0 }}
      >
        {props.label}
      </Label>
      <Label variant="small" style={{ flex: 1, minWidth: 0 }}>
        {props.value}
      </Label>
    </View>
  );
}

/** A 10pt muted band that heads a group of context rows. */
function ContextBand(props: { label: string; count?: string }) {
  const c = colors();
  return (
    <View
      style={{
        ...row,
        justifyContent: "space-between",
        backgroundColor: c().selected,
        paddingVertical: 4,
        paddingHorizontal: 12,
      }}
    >
      <Label variant="caption" tone="muted">
        {props.label}
      </Label>
      <If when={props.count}>
        <Label variant="caption" tone="muted">
          {props.count}
        </Label>
      </If>
    </View>
  );
}

/**
 * The agent part of a message: inline under it and folded on desktop and
 * phones, open in the thread context drawer on tablet. Its facts sit two to a
 * row in the drawer and on a phone.
 */
export function EmailMetaCard(props: {
  meta: EmailMetaView;
  drawer?: boolean;
  phone?: boolean;
}) {
  const c = colors();
  const open = signal(props.drawer ?? false);
  const technical = signal(false);
  const half = () => Boolean(props.drawer || props.phone);
  const labelWidth = () => (props.phone ? 96 : 140);
  const route = () =>
    [
      [uiText("metaAgentId"), props.meta.agentId],
      [uiText("metaSessionId"), props.meta.sessionId],
      [uiText("mailThread"), props.meta.mailThreadId],
      [uiText("metaTask"), props.meta.taskId],
      [uiText("metaCarrier"), props.meta.carrier],
    ].filter((entry): entry is [string, string] => !!entry[1]);
  const extra = () => payloadEntries(props.meta.payload);
  const total = () => route().length + extra().length;
  return (
    <View
      style={{
        backgroundColor: c().selected,
        borderWidth: 1,
        borderColor: c().border,
      }}
    >
      <View
        role="button"
        accessibilityLabel={uiText("agentCommunicationContext")}
        accessibilityState={{ expanded: open() }}
        onPress={() => open.set(!open())}
        style={{
          ...row,
          gap: 12,
          paddingVertical: 10,
          paddingHorizontal: 12,
          cursor: "pointer",
        }}
      >
        <View
          style={{
            width: 32,
            height: 32,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: c().canvas,
            borderWidth: 1,
            borderColor: c().border,
          }}
        >
          <Label variant="caption" weight={600}>
            ETA
          </Label>
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <View style={{ ...row, gap: 8 }}>
            <Label
              variant="small"
              weight={600}
              style={{ flexShrink: 1, minWidth: 0 }}
            >
              {uiText("agentCommunicationContext")}
            </Label>
            <Label
              variant="caption"
              tone="muted"
              style={{
                backgroundColor: c().canvas,
                borderWidth: 1,
                borderColor: c().border,
                paddingVertical: 2,
                paddingHorizontal: 6,
                flexShrink: 0,
              }}
            >
              {dataPoints(props.meta.packetCount)}
            </Label>
          </View>
          <Label variant="small" tone="muted" lines={1}>
            {[
              props.meta.agentName ?? "—",
              props.meta.protocol ?? "—",
              entries(total()),
            ].join(" · ")}
          </Label>
        </View>
        <View
          style={{ transform: open() ? [{ rotate: "180deg" }] : undefined }}
        >
          <Icon name="down" size={14} tone="muted" />
        </View>
      </View>
      <If when={open()}>
        <View
          style={{
            gap: 10,
            paddingVertical: 10,
            paddingHorizontal: 12,
            borderTopWidth: 1,
            borderColor: c().border,
          }}
        >
          <Label variant="small" tone="muted">
            {uiText("contextHint")}
          </Label>
          <View
            style={{
              flexDirection: "row",
              flexWrap: half() ? "wrap" : "nowrap",
              borderLeftWidth: 1,
              borderTopWidth: 1,
              borderColor: c().border,
            }}
          >
            <MetaStat
              half={half()}
              label={uiText("agent")}
              value={props.meta.agentName ?? "—"}
            />
            <MetaStat
              half={half()}
              label={uiText("protocol")}
              value={props.meta.protocol ?? "—"}
            />
            <MetaStat
              half={half()}
              label={uiText("dataPoints")}
              value={dataPoints(props.meta.packetCount)}
            />
            <MetaStat
              half={half()}
              label={uiText("signature")}
              value={signatureText(props.meta)}
              verified={props.meta.signatureValid === true}
            />
          </View>
          <View
            style={{
              backgroundColor: c().canvas,
              borderWidth: 1,
              borderColor: c().border,
            }}
          >
            <View
              style={{
                ...row,
                justifyContent: "space-between",
                paddingVertical: 6,
                paddingHorizontal: 12,
                borderBottomWidth: 1,
                borderColor: c().border,
              }}
            >
              <Label variant="small" weight={600}>
                {uiText("context")}
              </Label>
              <Label variant="caption" tone="muted">
                {entries(total())}
              </Label>
            </View>
            <ContextBand label={uiText("communicationRoute")} />
            <Each of={route()} key={(entry) => entry[0]}>
              {(entry) => (
                <ContextRow
                  label={entry()[0]}
                  value={entry()[1]}
                  labelWidth={labelWidth()}
                />
              )}
            </Each>
            <ContextBand
              label={uiText("additionalContext")}
              count={entries(extra().length)}
            />
            <If
              when={extra().length}
              else={
                <View
                  style={{ gap: 2, paddingVertical: 8, paddingHorizontal: 12 }}
                >
                  <Label variant="small">{uiText("noExtraContext")}</Label>
                  <Label variant="caption" tone="muted">
                    {uiText("noExtraContextHint")}
                  </Label>
                </View>
              }
            >
              <Each of={extra().slice(0, 6)} key={(entry) => entry[0]}>
                {(entry) => (
                  <ContextRow
                    label={entry()[0]}
                    value={entry()[1]}
                    labelWidth={labelWidth()}
                    last={entry()[0] === extra().slice(0, 6).at(-1)?.[0]}
                  />
                )}
              </Each>
            </If>
          </View>
          <View
            style={{
              backgroundColor: c().canvas,
              borderWidth: 1,
              borderColor: c().border,
            }}
          >
            <View
              role="button"
              accessibilityLabel={uiText("technicalDetails")}
              accessibilityState={{ expanded: technical() }}
              onPress={() => technical.set(!technical())}
              style={{
                ...row,
                gap: 8,
                paddingVertical: 8,
                paddingHorizontal: 12,
                cursor: "pointer",
              }}
            >
              <View
                style={{
                  transform: technical() ? [{ rotate: "180deg" }] : undefined,
                }}
              >
                <Icon name="down" size={12} tone="muted" />
              </View>
              <Label variant="small">{uiText("technicalDetails")}</Label>
            </View>
            <If when={technical()}>
              <View style={{ borderTopWidth: 1, borderColor: c().border }}>
                <ContextRow
                  label={uiText("protocol")}
                  value={props.meta.protocol ?? "—"}
                  labelWidth={labelWidth()}
                />
                <ContextRow
                  label={uiText("dataPoints")}
                  value={dataPoints(props.meta.packetCount)}
                  labelWidth={labelWidth()}
                />
                <ContextRow
                  label={uiText("signature")}
                  value={signatureText(props.meta)}
                  labelWidth={labelWidth()}
                />
                <ContextRow
                  label={uiText("decode")}
                  value={props.meta.decodeError ?? uiText("decodeSucceeded")}
                  labelWidth={labelWidth()}
                  last
                />
              </View>
            </If>
          </View>
        </View>
      </If>
    </View>
  );
}

/** Tablet: the thread's agent context in a side drawer, opened from the pane
 * header. Desktop and phones fold the same card under the message. */
export function EmailContext(props: {
  message: EmailMessageView;
  onClose: () => void;
}) {
  const meta = () => props.message.meta;
  return (
    <Modal
      title={uiText("threadContext")}
      width={360}
      height="100%"
      side
      onClose={props.onClose}
    >
      <SmoothScroll style={grow} scrollbar={false}>
        <View style={{ padding: 12, gap: 12 }}>
          <If when={meta()?.carrier !== "none" ? meta() : undefined}>
            {(value) => <EmailMetaCard meta={value()} drawer />}
          </If>
          <If when={meta()?.decodeError}>
            <Label variant="small" tone="red">
              {meta()?.decodeError}
            </Label>
          </If>
        </View>
      </SmoothScroll>
    </Modal>
  );
}

export function EmailProcess(props: {
  assignment: EmailAssignmentView;
  phone: boolean;
  onClose: () => void;
}) {
  const host = useHost();
  const target = () => `sessions.${props.assignment.sessionId}`;
  follow(target);
  const transcript = () =>
    host.section<TranscriptSection>(target(), "transcript");
  const steps = () =>
    runBlocks(
      transcript()?.messages.filter(
        (message) => message.at >= props.assignment.createdAt - 1,
      ) ?? [],
      host.section<ViewCore>(target(), "core")?.streaming,
    );
  return (
    <Modal
      title={uiText("processingSession")}
      phone={props.phone}
      width={620}
      height={props.phone ? "90%" : 520}
      onClose={props.onClose}
    >
      <SmoothScroll style={grow}>
        <View style={{ padding: 16, gap: 12 }}>
          <If
            when={steps().length}
            else={
              <Label tone="muted">
                {host.state().missing[target()]
                  ? uiText("sessionUnavailable")
                  : transcript()
                    ? uiText("noStepsYet")
                    : uiText("loadingSession")}
              </Label>
            }
          >
            <Each of={steps()} key={(step) => step.id}>
              {(step) => (
                <Markdown
                  value={
                    "text" in step()
                      ? (step() as { text: string }).text
                      : "name" in step()
                        ? (step() as { name: string }).name
                        : "Message joined this run"
                  }
                />
              )}
            </Each>
          </If>
        </View>
      </SmoothScroll>
    </Modal>
  );
}

export function AssignEmail(props: {
  ids: string[];
  phone: boolean;
  onClose: () => void;
  onAssigned: (id: string) => void;
}) {
  const host = useHost();
  const agent = signal("");
  const project = signal("");
  const busy = signal(false);
  return (
    <Modal
      title={
        props.ids.length > 1
          ? uiText("handCountToAnAgent", { count: props.ids.length })
          : uiText("handToAnAgent")
      }
      phone={props.phone}
      sheet={props.phone}
      plainSheetHeader={props.phone}
      overPhoneNavigation={props.phone}
      compact={!props.phone}
      titleWeight={500}
      onClose={props.onClose}
    >
      <View style={props.phone ? undefined : { paddingTop: 14 }}>
        <View
          style={
            props.phone
              ? {
                  gap: 16,
                  paddingHorizontal: 16,
                  paddingTop: 4,
                  paddingBottom: 8,
                }
              : { gap: 12 }
          }
        >
          <AssignField
            phone={props.phone}
            label={uiText("agent")}
            value={agent()}
            items={host
              .people()
              .map((item) => ({ value: item.id, title: item.name }))}
            onChange={(value) => agent.set(value)}
          />
          <AssignField
            phone={props.phone}
            label={uiText("project2")}
            value={project()}
            items={host
              .projects()
              .filter((item) => item.kind === "project" && !item.archived)
              .map((item) => ({
                value: item.id,
                title: `${item.name} · ${item.path}`,
              }))}
            onChange={(value) => project.set(value)}
          />
        </View>
        <View
          style={
            props.phone
              ? { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24 }
              : { ...row, justifyContent: "flex-end", paddingTop: 20 }
          }
        >
          <Button
            label={uiText("startProcessing")}
            tone="primary"
            size={props.phone ? 40 : 28}
            disabled={!agent() || !project() || busy()}
            onPress={() =>
              void (async () => {
                if (busy()) return;
                busy.set(true);
                const result = await host.action(() =>
                  host.call<EmailResults["assign"]>("email", "assign", {
                    threadIds: props.ids,
                    agentId: agent(),
                    projectId: project(),
                  }),
                );
                busy.set(false);
                if (result) {
                  props.onClose();
                  props.onAssigned(result.conversationId);
                }
              })()
            }
          />
        </View>
      </View>
    </Modal>
  );
}

/** A labelled select, the design's Agent and Project fields: 28pt, 40pt on
 * a phone. */
function AssignField(props: {
  phone: boolean;
  label: string;
  value: string;
  items: { value: string; title: string }[];
  onChange: (value: string) => void;
}) {
  const c = colors();
  const type = textFaces();
  return (
    <View style={{ gap: 4 }}>
      <Label variant="small" tone="muted">
        {props.label}
      </Label>
      <LayoutSelect
        accessibilityLabel={props.label}
        items={props.items}
        value={props.value || null}
        cover={false}
        offset={2}
        popupStyle={{
          borderWidth: 1,
          borderColor: c().strong,
          backgroundColor: c().canvas,
        }}
        itemStyle={{
          minHeight: 28,
          paddingHorizontal: 8,
          color: c().ink,
          fontSize: type("small").size,
        }}
        trigger={
          <View
            style={{
              ...row,
              gap: 8,
              height: props.phone ? 40 : 28,
              paddingHorizontal: props.phone ? 12 : 8,
              borderWidth: 1,
              borderColor: c().border,
              backgroundColor: c().canvas,
              cursor: "pointer",
            }}
          >
            <Label variant="small" lines={1} style={{ flex: 1 }}>
              {props.items.find((item) => item.value === props.value)?.title ??
                ""}
            </Label>
            <Icon name="down" size={props.phone ? 14 : 10} tone="muted" />
          </View>
        }
        onChange={({ value }) => {
          if (value !== null) props.onChange(value);
        }}
      />
    </View>
  );
}
