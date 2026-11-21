import type {
  EmailAssignmentView,
  EmailMessageView,
  EmailProposalView,
  TranscriptSection,
  ViewCore,
} from "@eta/client-contracts";
import { runBlocks, splitReply } from "@eta/client-contracts";
import { Scroll, signal, View } from "nsh";
import { Button, colors, Icon, Label, Modal, row } from "../../components";
import { formatLocale, uiText } from "../../i18n";
import { follow, useHost } from "../../services/host";
import { EmailProposal } from "./proposal";
import { EmailInfo } from "./thread-context";

export function AssignmentDetail(props: {
  assignment: EmailAssignmentView;
  message?: EmailMessageView;
  rootMessageId?: string | null;
  phone: boolean;
  onClose: () => void;
  onOpenSession: () => void;
}) {
  const host = useHost();
  return (
    <Modal
      title={uiText("processingAgent2")}
      phone={props.phone}
      sheet={props.phone}
      plainSheetHeader={props.phone}
      overPhoneNavigation={props.phone}
      side={!props.phone}
      width={360}
      height={props.phone ? undefined : "100%"}
      onClose={props.onClose}
    >
      <Scroll style={{ flexShrink: 1 }}>
        <View
          style={{
            paddingHorizontal: 16,
            paddingVertical: props.phone ? 0 : 16,
          }}
        >
          <EmailInfo
            label={uiText("agent")}
            value={
              host.agent(props.assignment.agentId)?.name ?? uiText("agent")
            }
            phoneRow={props.phone}
            agentId={props.assignment.agentId}
          />
          <EmailInfo
            label={uiText("project2")}
            phoneRow={props.phone}
            value={
              host
                .projects()
                .find((item) => item.id === props.assignment.projectId)?.name
            }
          />
          <EmailInfo
            label={uiText("received")}
            phoneRow={props.phone}
            value={new Date(
              props.message?.createdAt ?? props.assignment.createdAt,
            ).toLocaleString(formatLocale(), {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              hourCycle: "h23",
            })}
          />
          <EmailInfo
            label="Message-ID"
            phoneRow={props.phone}
            compact
            value={props.message?.rfcMessageId ?? props.rootMessageId}
          />
        </View>
      </Scroll>
      <View
        style={{
          paddingHorizontal: 16,
          paddingTop: props.phone ? 16 : 8,
          paddingBottom: props.phone ? 24 : 16,
        }}
      >
        <Button
          label={uiText("openProcessingSession")}
          tone="primary"
          size={props.phone ? 40 : 32}
          onPress={props.onOpenSession}
        />
      </View>
    </Modal>
  );
}

/** Off phones: the processing row opened in place, with the run's state, its
 * answer once it finished, and the steps it took folded under a log row with
 * the emails it proposed. The log starts open while one waits for the user. */
export function AssignmentInline(props: {
  assignment: EmailAssignmentView;
  proposals: EmailProposalView[];
  onOpenSession: () => void;
}) {
  const host = useHost();
  const c = colors();
  const logOpen = signal(
    props.proposals.some(
      (item) => item.status === "pending" || item.status === "failed",
    ),
  );
  const target = () => `sessions.${props.assignment.sessionId}`;
  follow(target);
  const core = () => host.section<ViewCore>(target(), "core");
  const transcript = () =>
    host.section<TranscriptSection>(target(), "transcript");
  const blocks = () =>
    runBlocks(
      transcript()?.messages.filter(
        (message) => message.at >= props.assignment.createdAt - 1,
      ) ?? [],
      core()?.streaming,
    );
  const running = () => core()?.running ?? false;
  const reply = () => splitReply(blocks());
  const result = () =>
    running()
      ? ""
      : reply()
          .answer.map((block) => ("text" in block ? block.text : ""))
          .join("\n\n")
          .trim();
  const steps = () => (running() ? blocks() : reply().steps);
  return (
    <View
      style={{
        gap: 12,
        paddingBottom: 12,
        borderBottomWidth: 1,
        borderColor: c().border,
      }}
    >
      <View style={row}>
        <Button
          label={uiText("openProcessingSession")}
          onPress={props.onOpenSession}
        />
      </View>
      <If when={transcript()}>
        <View style={{ ...row, gap: 8 }}>
          <View
            style={{
              width: 6,
              height: 6,
              flexShrink: 0,
              backgroundColor: c().ink,
            }}
          />
          <Label size={12} line={16} tone="muted">
            {running() ? uiText("processing") : uiText("processingFinished")}
          </Label>
        </View>
      </If>
      <If when={result()}>
        <View
          style={{
            gap: 4,
            paddingLeft: 12,
            borderLeftWidth: 2,
            borderColor: c().ink,
          }}
        >
          <Label size={12} line={16} weight={500}>
            {uiText("result")}
          </Label>
          <Label size={12} line={18}>
            {result()}
          </Label>
        </View>
      </If>
      <View style={{ borderWidth: 1, borderColor: c().border }}>
        <View
          role="button"
          accessibilityLabel={uiText("processingLog")}
          accessibilityState={{ expanded: logOpen() }}
          onPress={() => logOpen.set(!logOpen())}
          hoverStyle={{ backgroundColor: c().selected }}
          style={{
            ...row,
            gap: 8,
            height: 28,
            paddingHorizontal: 8,
            cursor: "pointer",
          }}
        >
          <Icon name={logOpen() ? "down" : "right"} size={10} tone="muted" />
          <Label size={12} line={16}>
            {uiText("processingLog")}
          </Label>
        </View>
        <If when={logOpen()}>
          <View
            style={{
              gap: 8,
              padding: 12,
              borderTopWidth: 1,
              borderColor: c().border,
            }}
          >
            <If
              when={steps().length || props.proposals.length}
              else={
                <Label size={12} line={16} tone="muted">
                  {host.state().missing[target()]
                    ? uiText("sessionUnavailable")
                    : transcript()
                      ? uiText("noProcessingActivityYet")
                      : uiText("loadingSession")}
                </Label>
              }
            >
              <Each of={steps()} key={(step) => step.id}>
                {(step) => (
                  <Label
                    size={12}
                    line={18}
                    tone={"text" in step() ? undefined : "mutedInk"}
                  >
                    {"text" in step()
                      ? (step() as { text: string }).text
                      : "name" in step()
                        ? (step() as { name: string }).name
                        : ""}
                  </Label>
                )}
              </Each>
              <Each of={props.proposals} key={(item) => item.id}>
                {(item) => <EmailProposal item={item()} />}
              </Each>
            </If>
          </View>
        </If>
      </View>
    </View>
  );
}
