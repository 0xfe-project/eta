import type {
  EmailAssignmentView,
  EmailMessageView,
  EmailMetaView,
  EmailResults,
  TranscriptSection,
  ViewCore,
} from "@eta/client-contracts";
import type { Layout } from "../../components";
import { runBlocks } from "@eta/client-contracts";
import { Scroll, signal, View } from "nsh";
import {
  Button,
  Caption,
  colors,
  grow,
  Icon,
  Label,
  Markdown,
  Modal,
  row,
} from "../../components";
import { AgentFace } from "../../components/agent-face";
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
        <Label size={12} tone="muted" style={{ width: 88, flexShrink: 0 }}>
          {props.label}
        </Label>
        <If when={props.agentId && props.phoneRow}>
          <AgentFace id={props.agentId} size={20} />
        </If>
        <Label
          size={props.phoneRow && !props.compact ? 14 : 12}
          line={props.phoneRow && props.compact ? 16 : undefined}
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
        size={10}
        line={16}
        tone="muted"
        style={{ letterSpacing: 0.5, textTransform: "uppercase" }}
      >
        {props.label}
      </Label>
      <Label
        size={12}
        line={16}
        tone={props.verified ? "green" : "ink"}
        lines={1}
      >
        {props.value}
      </Label>
    </View>
  );
}

/**
 * The agent part of a message: inline under it and folded on desktop, open in
 * the thread context drawer with its facts two to a row on tablet.
 */
export function EmailMetaCard(props: {
  meta: EmailMetaView;
  drawer?: boolean;
}) {
  const c = colors();
  const open = signal(props.drawer ?? false);
  const route = () =>
    [
      [uiText("metaAgentId"), props.meta.agentId],
      [uiText("metaSessionId"), props.meta.sessionId],
      [uiText("mailThread"), props.meta.mailThreadId],
      [uiText("metaTask"), props.meta.taskId],
    ].filter((entry): entry is [string, string] => !!entry[1]);
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
          <Label size={10} line={16} weight={600}>
            ETA
          </Label>
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <View style={{ ...row, gap: 8 }}>
            <Label
              size={12}
              line={16}
              weight={600}
              style={{ flexShrink: 1, minWidth: 0 }}
            >
              {uiText("agentCommunicationContext")}
            </Label>
            <Label
              size={10}
              line={16}
              tone="muted"
              style={{
                backgroundColor: c().canvas,
                borderWidth: 1,
                borderColor: c().border,
                paddingVertical: 2,
                paddingHorizontal: 6,
                flexShrink: 1,
                minWidth: 0,
              }}
            >
              {dataPoints(props.meta.packetCount)}
            </Label>
          </View>
          <Label size={11} line={16} tone="muted" lines={1}>
            {[
              props.meta.agentName ?? "—",
              props.meta.protocol ?? "—",
              entries(route().length),
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
          <Label size={11} line={16} tone="muted">
            {uiText("contextHint")}
          </Label>
          <View
            style={{
              flexDirection: "row",
              flexWrap: props.drawer ? "wrap" : "nowrap",
              borderLeftWidth: 1,
              borderTopWidth: 1,
              borderColor: c().border,
            }}
          >
            <MetaStat
              half={props.drawer}
              label={uiText("agent")}
              value={props.meta.agentName ?? "—"}
            />
            <MetaStat
              half={props.drawer}
              label={uiText("protocol")}
              value={props.meta.protocol ?? "—"}
            />
            <MetaStat
              half={props.drawer}
              label={uiText("dataPoints")}
              value={dataPoints(props.meta.packetCount)}
            />
            <MetaStat
              half={props.drawer}
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
              <Label size={12} line={16} weight={600}>
                {uiText("context")}
              </Label>
              <Label size={10} line={16} tone="muted">
                {entries(route().length)}
              </Label>
            </View>
            <Label
              size={10}
              line={16}
              tone="muted"
              style={{
                backgroundColor: c().selected,
                paddingVertical: 4,
                paddingHorizontal: 12,
              }}
            >
              {uiText("communicationRoute")}
            </Label>
            <Each of={route()} key={(entry) => entry[0]}>
              {(entry) => (
                <View
                  style={{
                    flexDirection: "row",
                    gap: 12,
                    paddingVertical: 6,
                    paddingHorizontal: 12,
                    borderBottomWidth:
                      entry()[0] === route().at(-1)?.[0] ? 0 : 1,
                    borderColor: c().border,
                  }}
                >
                  <Label
                    size={10}
                    line={16}
                    tone="muted"
                    style={{ width: 140, flexShrink: 0 }}
                  >
                    {entry()[0]}
                  </Label>
                  <Label size={11} line={16} style={{ flex: 1, minWidth: 0 }}>
                    {entry()[1]}
                  </Label>
                </View>
              )}
            </Each>
          </View>
        </View>
      </If>
    </View>
  );
}

export function EmailContext(props: {
  message: EmailMessageView;
  layout: Layout;
  onClose: () => void;
}) {
  const c = colors();
  const meta = () => props.message.meta;
  const phone = () => props.layout === "phone";
  return (
    <Modal
      title={uiText("threadContext")}
      width={360}
      height={phone() ? "74%" : "100%"}
      side={!phone()}
      phone={phone()}
      onClose={props.onClose}
    >
      <Scroll style={grow} scrollbar={false}>
        <View style={{ padding: 12, gap: 12 }}>
          <If
            when={!phone() && meta()?.carrier !== "none" ? meta() : undefined}
          >
            {(value) => <EmailMetaCard meta={value()} drawer />}
          </If>
          <If when={phone() && meta() && meta()!.carrier !== "none"}>
            <View
              style={{
                padding: 12,
                backgroundColor: c().surface,
                borderWidth: 1,
                borderColor: c().border,
              }}
            >
              <Label weight={600}>{uiText("agentCommunicationContext")}</Label>
              <EmailInfo
                label={uiText("agent")}
                value={meta()?.agentName ?? meta()?.agentId}
              />
              <EmailInfo label={uiText("protocol")} value={meta()?.protocol} />
              <EmailInfo
                label={uiText("dataPoints")}
                value={String(meta()?.packetCount ?? 0)}
              />
              <EmailInfo
                label={uiText("signature")}
                value={meta() ? signatureText(meta()!) : undefined}
              />
              <EmailInfo
                label={uiText("mailThread")}
                value={meta()?.mailThreadId}
              />
              <EmailInfo label={uiText("session")} value={meta()?.sessionId} />
              <EmailInfo label="Task" value={meta()?.taskId} />
              <EmailInfo
                label={uiText("currentWork")}
                value={meta()?.payload?.work.doing}
              />
              <EmailInfo
                label={uiText("question")}
                value={meta()?.payload?.ask.question}
              />
            </View>
          </If>
          <If when={meta()?.decodeError}>
            <Label size={12} tone="red">
              {meta()?.decodeError}
            </Label>
          </If>
        </View>
      </Scroll>
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
      <Scroll style={grow}>
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
      </Scroll>
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
      title={uiText("assignEmail")}
      phone={props.phone}
      onClose={props.onClose}
    >
      <View style={{ padding: 16, gap: 8 }}>
        <Caption text={uiText("agent")} />
        <View style={{ ...row, flexWrap: "wrap", gap: 5 }}>
          <Each of={host.people()} key={(item) => item.id}>
            {(item) => (
              <Button
                label={item().name}
                selected={agent() === item().id}
                onPress={() => agent.set(item().id)}
              />
            )}
          </Each>
        </View>
        <Caption text={uiText("project2")} />
        <View style={{ ...row, flexWrap: "wrap", gap: 5 }}>
          <Each
            of={host
              .projects()
              .filter((item) => item.kind === "project" && !item.archived)}
            key={(item) => item.id}
          >
            {(item) => (
              <Button
                label={item().name}
                selected={project() === item().id}
                onPress={() => project.set(item().id)}
              />
            )}
          </Each>
        </View>
        <Button
          label={uiText("assign2")}
          tone="primary"
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
    </Modal>
  );
}
