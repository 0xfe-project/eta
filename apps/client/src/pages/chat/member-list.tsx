import type {
  ConversationInfo,
  GenerationRate,
  MemberSpend,
  MemberView,
} from "@eta/client-contracts";
import { displaySpend } from "@eta/client-contracts";
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
import { ContextRing, useContextUsage } from "../../components/context-ring";
import { hint } from "../../components/controls";
import { EmptyState } from "../../components/empty-state";
import { StatusDot } from "../../components/status-dot";
import { avatar, icon, sizes, space } from "../../components/tokens";
import { formatLocale, uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { activeReply, memberStatus } from "./member-status";
import { MemberStepsLedger, MemberStepsToggle } from "./member-steps";

/** The bar atop the member list. */

export function ConversationMembers(props: {
  members: MemberView[];
  group: boolean;
  info?: ConversationInfo;
  expandedSession: string;
  onToggleSteps: (session: string) => void;
  onInspect: (member: { id: string; session: string }) => void;
  onInvite: () => void;
  onRemove: (agentId: string) => void;
}) {
  const host = useHost();
  const c = colors();
  return (
    <>
      <View
        style={{
          ...row,
          justifyContent: "space-between",
          height: sizes.sectionHeader,
          paddingHorizontal: space[12],
          borderBottomWidth: 1,
          borderColor: c().border,
        }}
      >
        <Label variant="small" tone="muted">
          {uiText(
            props.members.length === 1
              ? "oneConversationMember"
              : "conversationMembers",
            {
              count: props.members.length,
            },
          )}
        </Label>
        <If when={props.group}>
          <Button
            label={uiText("invite2")}
            tone="ghost"
            labelTone="muted"
            disabled={props.info?.archived}
            onPress={props.onInvite}
          />
        </If>
      </View>
      <If when={!props.members.length}>
        <EmptyState
          size="row"
          status="empty"
          loading={null}
          error={null}
          empty={{
            title: uiText("noMembersYet"),
            actions:
              props.group && !props.info?.archived
                ? [{ label: uiText("invite2"), onPress: props.onInvite }]
                : undefined,
          }}
          style={{
            paddingHorizontal: space[12],
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        />
      </If>
      <Each of={props.members} key={(entry) => entry.agentId}>
        {(entry) => (
          <View style={{ borderBottomWidth: 1, borderColor: c().border }}>
            <View
              style={{
                ...row,
                paddingVertical: space[8],
                paddingHorizontal: space[12],
                gap: space[8],
              }}
            >
              <MemberFace
                agentId={entry().agentId}
                session={entry().sessionId}
              />
              <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
                <View style={{ ...row, gap: space[4] }}>
                  <Label lines={1}>
                    {host.agent(entry().agentId)?.name ?? uiText("agent")}
                  </Label>
                  <StatusDot
                    color={activeReply(entry().status) ? c().blue : c().muted}
                    opacity={activeReply(entry().status) ? 1 : 0.4}
                  />
                  <Label variant="caption" tone="muted">
                    {memberStatus(entry().status)}
                  </Label>
                  <If
                    when={
                      entry().status === "working" ? entry().sessionId : null
                    }
                  >
                    {(session) => <MemberRate session={session()} />}
                  </If>
                </View>
                <If
                  when={entry().sessionId}
                  else={
                    <Label variant="caption" tone="muted" lines={1}>
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
              <View style={{ ...row, gap: space[4], flexShrink: 0 }}>
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
                    minWidth: icon.md,
                    width: icon.md,
                    height: space[24],
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
                      onSelect={() => props.onRemove(entry().agentId)}
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
              <MemberStepsLedger session={entry().sessionId!} />
            </If>
          </View>
        )}
      </Each>
    </>
  );
}

/**
 * A member's face in a fixed slot, the ring's size, ringed by how full its context is. A member with no
 * session yet has nothing to measure, so it is the face alone, in the same slot.
 */
function MemberFace(props: { agentId: string; session: string | null }) {
  const usage = useContextUsage(() => props.session ?? undefined);
  return (
    <If
      when={props.session}
      else={
        <View
          style={{
            width: avatar.xl,
            height: avatar.xl,
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <AgentFace id={props.agentId} size={avatar.md} />
        </View>
      }
    >
      <ContextRing usage={usage} size={avatar.xl}>
        <AgentFace id={props.agentId} size={avatar.md} />
      </ContextRing>
    </If>
  );
}

/**
 * How fast a working member's model writes: the estimate of the generation in flight, else the
 * last generation's measured rate.
 */
function MemberRate(props: { session: string }) {
  const host = useHost();
  const c = colors();
  const rate = () =>
    host.section<GenerationRate | null>(`sessions.${props.session}`, "rate");
  return (
    <If when={rate()}>
      {(current) => (
        <View
          tooltip={hint(
            uiText(
              current().basis === "estimate"
                ? "memberRateEstimate"
                : "memberRateMeasured",
            ),
            c,
          )}
          style={{ ...row, gap: space[4], flexShrink: 0 }}
        >
          <Label variant="caption" tone="muted">
            ·
          </Label>
          <Label variant="caption" tone="muted" mono>
            {`${current().basis === "estimate" ? "≈" : ""}${uiText(
              "memberRate",
              { rate: String(Math.round(current().tokensPerSec)) },
            )}`}
          </Label>
        </View>
      )}
    </If>
  );
}

/**
 * What one member's session holds and has spent, on one line: how full the context is, then the
 * tokens and the tool count. The model is a name, not a count, and the one field that can run
 * longer than the row, so it is the line's tooltip (as in the web sidebar's inline stats).
 */
function MemberStats(props: { session: string; model?: string | null }) {
  const host = useHost();
  const c = colors();
  const target = () => `sessions.${props.session}`;
  const context = useContextUsage(() => props.session);
  const spend = (key: keyof MemberSpend) =>
    displaySpend(
      host.section<MemberSpend>(target(), "spend")?.[key],
      formatLocale(),
    );
  const tools = () => host.section<unknown[]>(target(), "tools");
  const model = () =>
    host.section<{ id: string }>(target(), "model")?.id ??
    props.model ??
    uiText("defaultModel");
  const spent = () =>
    `${uiText("memberUsage", {
      input: spend("input"),
      output: spend("output"),
      cache: spend("cache"),
    })} · ${uiText("memberTools", {
      count: tools() ? String(tools()!.length) : "—",
    })}`;
  return (
    <View tooltip={hint(model(), c)} style={{ ...row, minWidth: 0 }}>
      <If when={context()}>
        {(current) => (
          <Label variant="caption" style={{ flexShrink: 0 }}>
            {current().label}
          </Label>
        )}
      </If>
      <Label variant="caption" tone="muted" lines={1} style={{ flex: 1 }}>
        {context() ? ` · ${spent()}` : spent()}
      </Label>
    </View>
  );
}
