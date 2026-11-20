import type { ConversationInfo, MemberView } from "@eta/client-contracts";
import { View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  Label,
  row,
} from "../../components";
import { AgentFace } from "../../components/agent-face";
import { StatusDot } from "../../components/status-dot";
import { uiText } from "../../i18n";
import { follow, useHost } from "../../services/host";
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
                paddingVertical: 14,
                paddingHorizontal: 12,
                gap: 12,
              }}
            >
              <If
                when={entry().sessionId}
                else={<AgentFace id={entry().agentId} size={28} />}
              >
                <View
                  style={{
                    ...row,
                    justifyContent: "center",
                    width: 40,
                    height: 40,
                    flexShrink: 0,
                    borderWidth: 3,
                    borderColor: c().selected,
                    borderRadius: 20,
                  }}
                >
                  <AgentFace id={entry().agentId} size={26} />
                </View>
              </If>
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <View style={{ ...row, gap: entry().sessionId ? 6 : 8 }}>
                  <Label line={18} lines={1}>
                    {host.agent(entry().agentId)?.name ?? uiText("agent")}
                  </Label>
                  <StatusDot
                    color={activeReply(entry().status) ? c().blue : c().muted}
                    opacity={activeReply(entry().status) ? 1 : 0.4}
                  />
                  <Label size={10} line={12} tone="muted">
                    {memberStatus(entry().status)}
                  </Label>
                </View>
                <If
                  when={entry().sessionId}
                  else={
                    <Label size={10} line={14} tone="muted">
                      {uiText("memberNoConversation")}
                    </Label>
                  }
                >
                  {(session) => (
                    <MemberStats
                      session={session()}
                      model={host.agent(entry().agentId)?.model}
                    />
                  )}
                </If>
              </View>
              <View style={{ ...row, gap: 6, flexShrink: 0 }}>
                <If when={entry().sessionId}>
                  {(session) => (
                    <>
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
                    </>
                  )}
                </If>
                <ActionMenu
                  label={uiText("memberActions", {
                    name: host.agent(entry().agentId)?.name ?? uiText("agent"),
                  })}
                  triggerStyle={{
                    minWidth: 14,
                    width: 14,
                    height: 24,
                    paddingHorizontal: 0,
                  }}
                >
                  <If when={props.group && props.info}>
                    <ActionItem
                      label={uiText("makeSteward")}
                      disabled={
                        props.info?.stewardId === entry().agentId ||
                        props.info?.archived
                      }
                      onSelect={() =>
                        void host.action(() =>
                          host.call("conversations", "setSteward", {
                            conversationId: props.info!.id,
                            agentId: entry().agentId,
                          }),
                        )
                      }
                    />
                    <ActionItem
                      label={uiText("removeMember")}
                      disabled={
                        props.members.length <= 1 || props.info?.archived
                      }
                      onSelect={props.onActions}
                    />
                  </If>
                  <If when={entry().sessionId}>
                    {(session) => (
                      <ActionItem
                        label={uiText("inspectRun")}
                        onSelect={() =>
                          props.onInspect({
                            id: entry().agentId,
                            session: session(),
                          })
                        }
                      />
                    )}
                  </If>
                </ActionMenu>
              </View>
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

const tokens = (count: number | undefined) =>
  count === undefined
    ? "—"
    : count >= 1_000_000
      ? `${(count / 1_000_000).toFixed(1)}M`
      : count >= 1_000
        ? `${(count / 1_000).toFixed(1)}k`
        : String(count);

/** What one member's session has spent: model, tokens, tools. */
function MemberStats(props: { session: string; model?: string | null }) {
  const host = useHost();
  const target = () => `sessions.${props.session}`;
  follow(target);
  const usage = () =>
    host.section<{
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    }>(target(), "usage");
  const tools = () => host.section<unknown[]>(target(), "tools");
  const model = () =>
    host.section<{ id: string }>(target(), "model")?.id ??
    props.model ??
    uiText("defaultModel");
  return (
    <>
      <Label size={10} line={14} tone="muted" lines={1}>
        {model()}
      </Label>
      <Label size={10} line={14} tone="muted" lines={1}>
        {uiText("memberUsage", {
          input: tokens(usage()?.input),
          output: tokens(usage()?.output),
          cache: tokens(
            usage() ? usage()!.cacheRead + usage()!.cacheWrite : undefined,
          ),
        })}
      </Label>
      <Label size={10} line={14} tone="muted">
        {uiText("memberTools", {
          count: tools() ? String(tools()!.length) : "—",
        })}
      </Label>
    </>
  );
}
