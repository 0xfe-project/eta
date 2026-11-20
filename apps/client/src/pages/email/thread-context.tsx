import type {
  EmailAssignmentView,
  EmailMessageView,
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
          weight={props.phoneRow && props.agentId ? 600 : undefined}
          style={{ flex: 1, minWidth: 0 }}
        >
          {props.value}
        </Label>
      </View>
    </If>
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
          <If when={meta() && meta()!.carrier !== "none"}>
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
                value={
                  meta()?.signatureValid === true
                    ? "Verified"
                    : meta()?.signaturePresent
                      ? "Unverified"
                      : "Not signed"
                }
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
              <If when={meta()?.decodeError}>
                <Label size={12} tone="red">
                  {meta()?.decodeError}
                </Label>
              </If>
            </View>
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
