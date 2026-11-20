import type { ConversationInfo, MemberView } from "@eta/client-contracts";
import { View } from "nsh";
import { Button, colors, Label, row } from "../../components";
import { AgentFace } from "../../components/agent-face";
import { StatusDot } from "../../components/status-dot";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { activeReply, memberStatus } from "./member-status";
import { MemberStepsLedger, MemberStepsToggle } from "./member-steps";

export function ConversationMembers(props: {
  members: MemberView[];
  group: boolean;
  info?: ConversationInfo;
  phone: boolean;
  expandedSession: string;
  onToggleSteps: (session: string) => void;
  onInspect: (member: { id: string; session: string }) => void;
  onInvite: () => void;
  onActions: () => void;
}) {
  const host = useHost();
  const c = colors();
  return (
    <>
      <View
        style={{
          ...row,
          justifyContent: "space-between",
          height: 37,
          paddingHorizontal: 12,
          borderBottomWidth: 1,
          borderColor: c().border,
        }}
      >
        <Label size={12} tone="muted">
          {uiText(
            props.members.length === 1
              ? "oneConversationMember"
              : "conversationMembers",
            {
              count: props.members.length,
            },
          )}
        </Label>
        <View style={{ ...row }}>
          <If when={props.group}>
            <Button
              label={uiText("invite2")}
              tone="ghost"
              disabled={props.info?.archived}
              onPress={props.onInvite}
            />
          </If>
          <Button
            label={uiText("conversationActions")}
            icon="more"
            iconOnly
            tone="ghost"
            disabled={!props.info}
            onPress={props.onActions}
          />
        </View>
      </View>
      <Each of={props.members} key={(entry) => entry.agentId}>
        {(entry) => (
          <View style={{ borderBottomWidth: 1, borderColor: c().border }}>
            <View
              style={{
                ...row,
                alignItems: "flex-start",
                padding: 12,
                gap: 12,
                minHeight: 76,
              }}
            >
              <View
                style={{
                  padding: 5,
                  borderWidth: 1,
                  borderColor: c().border,
                  borderRadius: 20,
                }}
              >
                <AgentFace id={entry().agentId} size={26} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <View style={{ ...row, gap: 7 }}>
                  <Label>
                    {host.agent(entry().agentId)?.name ?? uiText("agent")}
                  </Label>
                  <StatusDot
                    color={activeReply(entry().status) ? c().blue : c().strong}
                  />
                  <Label size={10} tone="muted">
                    {memberStatus(entry().status)}
                  </Label>
                </View>
                <Label size={10} tone="muted">
                  {host.agent(entry().agentId)?.model ??
                    (entry().sessionId
                      ? uiText("defaultModel")
                      : uiText("noConversationYet"))}
                </Label>
              </View>
              <If when={entry().sessionId}>
                {(session) => (
                  <View style={{ ...row, gap: 6 }}>
                    <MemberStepsToggle
                      session={session()}
                      open={props.expandedSession === session()}
                      onToggle={() => props.onToggleSteps(session())}
                    />
                    <Button
                      label={uiText("inspectRun")}
                      onPress={() =>
                        props.onInspect({
                          id: entry().agentId,
                          session: session(),
                        })
                      }
                    />
                  </View>
                )}
              </If>
            </View>
            <If
              when={
                entry().sessionId && props.expandedSession === entry().sessionId
              }
            >
              <MemberStepsLedger
                session={entry().sessionId!}
                phone={props.phone}
              />
            </If>
          </View>
        )}
      </Each>
    </>
  );
}
