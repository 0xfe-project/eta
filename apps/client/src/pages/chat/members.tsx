import type { MemberView } from "@eta/client-contracts";
import type { Layout } from "../../components";
import { signal, View, windowSize } from "nsh";
import { Dialog } from "nsh/base";
import {
  Button,
  colors,
  fill,
  grow,
  Icon,
  Label,
  Modal,
  row,
  SmoothScroll,
} from "../../components";
import { AgentFace } from "../../components/agent-face";
import { CheckControl } from "../../components/check-control";
import {
  canHover,
  inSheet,
  MenuFrame,
  MenuRow,
  MenuRule,
  touchRow,
  touchScreen,
} from "../../components/menu";
import { CloseButton } from "../../components/navigation-buttons";
import {
  avatar,
  control,
  icon,
  shadow,
  space,
  weight,
} from "../../components/tokens";
import { formatLocale, uiText } from "../../i18n";
import { useHost } from "../../services/host";

export function StewardMenu(props: {
  conversationId: string;
  members: MemberView[];
  current?: string | null;
}) {
  const host = useHost();
  const c = colors();
  async function choose(agentId: string | null) {
    if (agentId === (props.current ?? null)) return;
    await host.action(() =>
      host.call("conversations", "setSteward", {
        conversationId: props.conversationId,
        agentId,
      }),
    );
  }
  const itemStyle = () => ({
    ...row,
    gap: space[8],
    paddingHorizontal: inSheet() ? space[16] : space[12],
    height: inSheet() ? 52 : touchScreen ? touchRow : 30,
  });
  const hover = canHover ? { backgroundColor: c().selected } : undefined;
  return (
    <MenuFrame
      popupStyle={{
        width: 172,
        borderWidth: 1,
        borderColor: c().strong,
        backgroundColor: c().canvas,
      }}
      trigger={
        <View
          accessibilityLabel={uiText("steward2")}
          hitSlop={touchScreen ? 11 : undefined}
          hoverStyle={hover}
          style={{
            ...row,
            height: 22,
            gap: space[4],
            paddingHorizontal: space[8],
            borderWidth: 1,
            borderColor: c().border,
            cursor: "pointer",
          }}
        >
          <If when={props.current}>
            <AgentFace id={props.current} size={avatar.sm} />
          </If>
          <Label variant="small" tone="muted">
            {host.agent(props.current)?.name ?? uiText("steward2")}
          </Label>
          <Icon name="down" size={icon.sm} tone="muted" />
        </View>
      }
    >
      <Each of={props.members} key={(member) => member.agentId}>
        {(member) => (
          <MenuRow
            role="menuitemradio"
            checked={member().agentId === props.current}
            label={host.agent(member().agentId)?.name ?? uiText("agent")}
            style={itemStyle()}
            onSelect={() => void choose(member().agentId)}
          >
            <AgentFace id={member().agentId} size={avatar.sm} />
            <Label variant="caption" style={{ flex: 1 }}>
              {host.agent(member().agentId)?.name ?? uiText("agent")}
            </Label>
            <If when={member().agentId === props.current}>
              <Icon name="check" size={icon.sm} />
            </If>
          </MenuRow>
        )}
      </Each>
      <MenuRule style={{ height: 1, backgroundColor: c().border }} />
      <MenuRow
        role="menuitemradio"
        checked={!props.current}
        label={uiText("noSteward")}
        style={itemStyle()}
        onSelect={() => void choose(null)}
      >
        <Label variant="caption" style={{ flex: 1 }}>
          {uiText("noSteward")}
        </Label>
        <If when={!props.current}>
          <Icon name="check" size={icon.sm} />
        </If>
      </MenuRow>
    </MenuFrame>
  );
}

export function InviteAgents(props: {
  conversationId: string;
  members: MemberView[];
  layout: Layout;
  onClose: () => void;
}) {
  const host = useHost();
  const c = colors();
  const phone = () => props.layout === "phone";
  const title = () => uiText("inviteAgents");
  const selected = signal<string[]>([]);
  const saving = signal(false);
  const candidates = () =>
    host
      .people()
      .filter(
        (agent) => !props.members.some((member) => member.agentId === agent.id),
      );
  const inviteIds = () =>
    selected().filter((id) => candidates().some((agent) => agent.id === id));
  async function invite() {
    const agentIds = inviteIds();
    if (saving() || !agentIds.length) return;
    saving.set(true);
    const result = await host.action(() =>
      host.call("conversations", "invite", {
        conversationId: props.conversationId,
        agentIds,
      }),
    );
    saving.set(false);
    if (result) props.onClose();
  }
  const placement = () => ({
    left: Math.max(
      16,
      Math.min(windowSize().width / 2 + 16, windowSize().width - 400),
    ),
    top: Math.max(
      16,
      Math.min(windowSize().height / 2 - 32, windowSize().height - 264),
    ),
  });
  const content = () => (
    <>
      <If when={!phone()}>
        <View
          style={{
            ...row,
            justifyContent: "space-between",
            minHeight: 38,
            paddingHorizontal: space[16],
          }}
        >
          <Label weight={weight.regular}>{title()}</Label>
          <CloseButton
            size={18}
            iconSize={icon.sm}
            disabled={saving()}
            onPress={props.onClose}
            style={{ marginRight: -space[2] }}
          />
        </View>
      </If>
      <View
        style={{
          paddingHorizontal: space[16],
          paddingTop: phone() ? space[16] : space[2],
          gap: space[12],
          ...(phone() ? grow : {}),
        }}
      >
        <Label tone="muted" variant="caption">
          {uiText("membersCanReadTheGroupChat")}
        </Label>
        <SmoothScroll
          style={
            phone()
              ? grow
              : {
                  maxHeight: Math.max(
                    64,
                    Math.min(225, windowSize().height - placement().top - 148),
                  ),
                }
          }
          scrollbar={false}
        >
          <Each of={candidates()} key={(agent) => agent.id}>
            {(agent, index) => (
              <CheckControl
                size={icon.md}
                checked={selected().includes(agent().id)}
                label={agent().name}
                onChange={(checked) =>
                  selected.update((ids) =>
                    checked
                      ? [...ids, agent().id]
                      : ids.filter((id) => id !== agent().id),
                  )
                }
                style={{
                  ...row,
                  gap: phone() ? space[12] : space[8],
                  paddingHorizontal: phone() ? space[4] : 0,
                  minHeight: phone() ? 52 : 32,
                  borderTopWidth: phone() && index() === 0 ? 1 : 0,
                  borderBottomWidth: phone() ? 1 : 0,
                  borderColor: c().border,
                  cursor: "pointer",
                }}
              >
                <AgentFace
                  id={agent().id}
                  size={phone() ? avatar.md : avatar.sm}
                />
                <Label style={{ flex: phone() ? 1 : undefined }}>
                  {agent().name}
                </Label>
                <Label variant="caption" tone="muted">
                  {agent().runtime === "eta"
                    ? uiText("etaBuiltIn")
                    : agent().runtime}
                </Label>
              </CheckControl>
            )}
          </Each>
          <If when={!candidates().length}>
            <Label tone="muted">{uiText("allAgentsAreAlreadyMembers")}</Label>
          </If>
        </SmoothScroll>
      </View>
      <View
        style={{
          ...row,
          justifyContent: "flex-end",
          ...(phone()
            ? { height: 56, paddingHorizontal: space[16] }
            : { padding: space[16] }),
          gap: space[8],
          marginTop: phone() ? 0 : space[4],
          borderTopWidth: phone() ? 1 : 0,
          borderColor: c().border,
        }}
      >
        <If when={!phone() && candidates().length && !inviteIds().length}>
          <Label variant="caption" tone="muted" style={{ flex: 1 }}>
            {formatLocale().startsWith("zh")
              ? "勾选要邀请的智能体"
              : "Tick the agents to invite"}
          </Label>
        </If>
        <Button
          label={uiText("cancel")}
          size={phone() ? control.sm : control.md}
          tone={phone() ? "ghost" : "plain"}
          disabled={saving()}
          onPress={props.onClose}
        />
        <Button
          label={uiText("invite", { length: inviteIds().length })}
          tone="primary"
          size={phone() ? control.sm : control.md}
          disabled={saving() || !inviteIds().length}
          onPress={() => void invite()}
        />
      </View>
    </>
  );
  return (
    <If
      when={props.layout === "tablet"}
      else={
        <Modal
          title={title()}
          width={385}
          height={phone() ? 380 : undefined}
          phone={phone()}
          sheet={phone()}
          hideHeader={!phone()}
          overPhoneNavigation
          dismissible={!saving()}
          onClose={props.onClose}
        >
          {content()}
        </Modal>
      }
    >
      <Dialog
        accessibilityLabel={title()}
        animation="none"
        style={fill}
        backdropStyle={{ backgroundColor: c().sheetScrim }}
        closeOnEscape={!saving()}
        closeOnBackdropPress={!saving()}
        onOpenChange={({ open }) => {
          if (!open && !saving()) props.onClose();
        }}
      >
        <View
          role="dialog"
          accessibilityLabel={title()}
          style={{
            position: "absolute",
            ...placement(),
            width: 385,
            maxWidth: "100%",
            borderWidth: 1,
            borderColor: c().strong,
            backgroundColor: c().canvas,
            boxShadow: [shadow.popover],
          }}
        >
          {content()}
        </View>
      </Dialog>
    </If>
  );
}
