import type { MachineView, MemberView } from "@eta/client-contracts";
import type { Layout } from "../../components";
import { signal, View, windowSize } from "nsh";
import {
  Button,
  colors,
  dialogWidth,
  fill,
  focusRing,
  grow,
  Icon,
  Label,
  Modal,
  NativeDialog,
  row,
  SmoothScroll,
} from "../../components";
import { AgentFace } from "../../components/agent-face";
import { CheckControl } from "../../components/check-control";
import { EmptyState } from "../../components/empty-state";
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
import { showToast } from "../../components/toast";
import {
  avatar,
  control,
  icon,
  opacity,
  shadow,
  space,
  weight,
} from "../../components/tokens";
import { formatLocale, uiText } from "../../i18n";
import {
  agentAllowedOnMachine,
  onlyOnMachineNote,
} from "../../services/agent-machine";
import { useHost } from "../../services/host";
import { useLoadState } from "../../services/load-status";

/** The steward menu's rows: a sheet's on phones, a list row elsewhere (a touch screen's are
 * `touchRow`). */
const menuRowHeight = { sheet: 52, desktop: 32 } as const;
const menuWidth = 172;

/** Invite agents: its title bar off phones, an agent's row, the phone sheet and its footer. */
const inviteHeaderHeight = 40;
const agentRowHeight = { phone: 52, desktop: 32 } as const;
const phoneSheetHeight = 380;
const phoneFooterHeight = 56;

export function StewardMenu(props: {
  conversationId: string;
  members: MemberView[];
  current?: string | null;
}) {
  const host = useHost();
  const c = colors();
  const pending = signal<string | null | undefined>(undefined);
  let turn = 0;
  const activeSteward = () =>
    pending() !== undefined ? pending() : (props.current ?? null);
  function choose(agentId: string | null) {
    if (agentId === activeSteward()) return;
    const currentTurn = ++turn;
    pending.set(agentId);
    void host
      .optimistic(props.conversationId, { stewardId: agentId }, () =>
        host.call("conversations", "setSteward", {
          conversationId: props.conversationId,
          agentId,
        }),
      )
      .then(() => {
        if (turn !== currentTurn) return;
        setTimeout(() => {
          if (turn === currentTurn) pending.set(undefined);
        }, 1500);
      })
      .catch((problem: unknown) => {
        if (turn !== currentTurn) return;
        pending.set(undefined);
        showToast({
          title: uiText("saveFailed"),
          body: problem instanceof Error ? problem.message : String(problem),
          tone: "red",
          action: {
            label: uiText("retry"),
            onPress: () => choose(agentId),
          },
        });
      });
  }
  const itemStyle = () => ({
    ...row,
    gap: space[8],
    paddingHorizontal: inSheet() ? space[16] : space[12],
    height: inSheet()
      ? menuRowHeight.sheet
      : touchScreen
        ? touchRow
        : menuRowHeight.desktop,
  });
  const hovered = signal(false);
  const open = signal(false);
  const tone = () => (hovered() || open() ? "ink" : "muted");
  return (
    <MenuFrame
      onOpenChange={open.set}
      popupStyle={{
        width: menuWidth,
        borderWidth: 1,
        borderColor: c().strong,
        backgroundColor: c().canvas,
      }}
      trigger={
        <View
          accessibilityLabel={uiText("steward2")}
          hitSlop={touchScreen ? (control.touch - control.sm) / 2 : undefined}
          onMouseEnter={() => hovered.set(canHover)}
          onMouseLeave={() => hovered.set(false)}
          hoverStyle={canHover ? { borderColor: c().strong } : undefined}
          expandedStyle={{ borderColor: c().strong }}
          focusVisibleStyle={focusRing(c())}
          style={{
            ...row,
            height: control.sm,
            gap: space[4],
            paddingHorizontal: space[8],
            borderWidth: 1,
            borderColor: open() ? c().strong : c().border,
            cursor: "pointer",
          }}
        >
          <If when={activeSteward()}>
            <AgentFace id={activeSteward()} size={avatar.sm} />
          </If>
          <Label variant="small" tone={tone()}>
            {host.agent(activeSteward())?.name ?? uiText("steward2")}
          </Label>
          <Icon name="down" size={icon.sm} tone={tone()} />
        </View>
      }
    >
      <Each of={props.members} key={(member) => member.agentId}>
        {(member) => (
          <MenuRow
            role="menuitemradio"
            checked={member().agentId === activeSteward()}
            label={host.agent(member().agentId)?.name ?? uiText("agent")}
            style={itemStyle()}
            onSelect={() => choose(member().agentId)}
          >
            <AgentFace id={member().agentId} size={avatar.sm} />
            <Label variant="caption" style={{ flex: 1 }}>
              {host.agent(member().agentId)?.name ?? uiText("agent")}
            </Label>
            <If when={member().agentId === activeSteward()}>
              <Icon name="check" size={icon.sm} />
            </If>
          </MenuRow>
        )}
      </Each>
      <MenuRule style={{ height: 1, backgroundColor: c().border }} />
      <MenuRow
        role="menuitemradio"
        checked={!activeSteward()}
        label={uiText("noSteward")}
        style={itemStyle()}
        onSelect={() => choose(null)}
      >
        <Label variant="caption" style={{ flex: 1 }}>
          {uiText("noSteward")}
        </Label>
        <If when={!activeSteward()}>
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
  const agentsLoad = useLoadState({ targets: () => ["agents"] });
  const projectMachineId = () => {
    const conversation = host
      .conversations()
      .find((entry) => entry.id === props.conversationId);
    const project = conversation
      ? host.projects().find((entry) => entry.id === conversation.projectId)
      : undefined;
    return project && project.kind !== "agent_home"
      ? project.machineId
      : undefined;
  };
  const machines = () => host.list<MachineView>("machines");
  const candidates = () =>
    host
      .people()
      .filter(
        (agent) => !props.members.some((member) => member.agentId === agent.id),
      );
  const inviteIds = () => {
    const machineId = projectMachineId();
    return selected().filter((id) => {
      const found = candidates().find((agent) => agent.id === id);
      return found !== undefined && agentAllowedOnMachine(found, machineId);
    });
  };
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
            minHeight: inviteHeaderHeight,
            paddingHorizontal: space[16],
          }}
        >
          <Label weight={weight.regular}>{title()}</Label>
          <CloseButton
            size={control.sm}
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
            {(agent, index) => {
              const note = () =>
                onlyOnMachineNote(agent(), projectMachineId(), machines());
              const disabled = () => note() !== undefined;
              return (
                <CheckControl
                  size={icon.md}
                  checked={!disabled() && selected().includes(agent().id)}
                  disabled={disabled()}
                  label={agent().name}
                  onChange={(checked) => {
                    if (disabled()) return;
                    selected.update((ids) =>
                      checked
                        ? [...ids, agent().id]
                        : ids.filter((id) => id !== agent().id),
                    );
                  }}
                  style={{
                    ...row,
                    gap: phone() ? space[12] : space[8],
                    paddingHorizontal: phone() ? space[4] : 0,
                    minHeight: phone()
                      ? agentRowHeight.phone
                      : agentRowHeight.desktop,
                    borderTopWidth: phone() && index() === 0 ? 1 : 0,
                    borderBottomWidth: phone() ? 1 : 0,
                    borderColor: c().border,
                    cursor: disabled() ? "default" : "pointer",
                    ...(disabled() ? { opacity: opacity.disabled } : {}),
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
                    {note() ??
                      (agent().runtime === "eta"
                        ? uiText("etaBuiltIn")
                        : agent().runtime)}
                  </Label>
                </CheckControl>
              );
            }}
          </Each>
          <If when={!candidates().length}>
            <EmptyState
              size="row"
              status={agentsLoad.shown()}
              loading={uiText("loadingAgents")}
              error={{
                title: uiText("agentsDidNotLoad"),
                retry: agentsLoad.retry,
                retrying: agentsLoad.retrying(),
              }}
              empty={{
                title: host.people().length
                  ? uiText("allAgentsAreAlreadyMembers")
                  : uiText("settingsNoAgents"),
              }}
              style={{ paddingHorizontal: 0 }}
            />
          </If>
        </SmoothScroll>
      </View>
      <View
        style={{
          ...row,
          justifyContent: "flex-end",
          ...(phone()
            ? { height: phoneFooterHeight, paddingHorizontal: space[16] }
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
          disabled={!inviteIds().length}
          busy={saving()}
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
          width={dialogWidth.md}
          height={phone() ? phoneSheetHeight : undefined}
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
      <NativeDialog
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
            width: dialogWidth.md,
            maxWidth: "100%",
            borderWidth: 1,
            borderColor: c().strong,
            backgroundColor: c().canvas,
            boxShadow: [shadow.popover],
          }}
        >
          {content()}
        </View>
      </NativeDialog>
    </If>
  );
}
