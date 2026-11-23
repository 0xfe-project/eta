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
import { formatLocale, localizedText, uiText } from "../../i18n";
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
    gap: 8,
    paddingHorizontal: inSheet() ? 16 : 10,
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
            gap: 6,
            paddingHorizontal: 6,
            borderWidth: 1,
            borderColor: c().border,
            cursor: "pointer",
          }}
        >
          <If when={props.current}>
            <AgentFace id={props.current} size={10} />
          </If>
          <Label variant="small" tone="muted">
            {host.agent(props.current)?.name ?? uiText("steward2")}
          </Label>
          <Icon name="down" size={8} tone="muted" />
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
            <AgentFace id={member().agentId} size={10} />
            <Label variant="caption" style={{ flex: 1 }}>
              {host.agent(member().agentId)?.name ?? uiText("agent")}
            </Label>
            <If when={member().agentId === props.current}>
              <Icon name="check" size={10} />
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
          <Icon name="check" size={10} />
        </If>
      </MenuRow>
    </MenuFrame>
  );
}

export function InviteAgents(props: {
  conversationId: string;
  members: MemberView[];
  layout: Layout;
  onTemplates: () => void;
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
            paddingHorizontal: 14,
          }}
        >
          <Label weight={500}>{title()}</Label>
          <CloseButton
            size={18}
            iconSize={14}
            disabled={saving()}
            onPress={props.onClose}
            style={{ marginRight: -2 }}
          />
        </View>
      </If>
      <View
        style={{
          paddingHorizontal: phone() ? 16 : 14,
          paddingTop: phone() ? 16 : 2,
          gap: 12,
          ...(phone() ? grow : {}),
        }}
      >
        <Label tone="muted" variant="caption">
          {uiText("membersCanReadTheGroupChat")}
        </Label>
        <If when={host.can("agents.createInGroup")}>
          <Button
            label={localizedText("Browse bot templates", "浏览 Bot 模板")}
            onPress={props.onTemplates}
          />
        </If>
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
                size={14}
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
                  gap: phone() ? 12 : 8,
                  paddingHorizontal: phone() ? 4 : 0,
                  minHeight: phone() ? 52 : 32,
                  borderTopWidth: phone() && index() === 0 ? 1 : 0,
                  borderBottomWidth: phone() ? 1 : 0,
                  borderColor: c().border,
                  cursor: "pointer",
                }}
              >
                <AgentFace id={agent().id} size={phone() ? 24 : 12} />
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
            ? { height: 56, paddingHorizontal: 16 }
            : { padding: 14 }),
          gap: 8,
          marginTop: phone() ? 0 : 4,
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
          size={phone() ? 24 : 28}
          tone={phone() ? "ghost" : "plain"}
          disabled={saving()}
          onPress={props.onClose}
        />
        <Button
          label={uiText("invite", { length: inviteIds().length })}
          tone="primary"
          size={phone() ? 24 : 28}
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
        backdropStyle={{ backgroundColor: c().sheetShade }}
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
            boxShadow: [{ x: 0, y: 8, blur: 24, color: "#0000001f" }],
          }}
        >
          {content()}
        </View>
      </Dialog>
    </If>
  );
}
