import type {
  ConversationResults,
  ProjectResults,
} from "@eta/client-contracts";
import type { Layout } from "../../components";
import { back } from "@eta/client-contracts";
import { signal, View, windowSize } from "nsh";
import {
  Button,
  colors,
  dialogWidth,
  grow,
  Label,
  Modal,
  row,
  SmoothScroll,
} from "../../components";
import { control, space, weight } from "../../components/tokens";
import { localizedText, uiText } from "../../i18n";
import { agentAllowedOnMachine } from "../../services/agent-machine";
import { useHost } from "../../services/host";
import { Callout } from "../../ui";
import { ConversationMembers } from "./conversation-members";
import { DirectoryOptions } from "./directory-options";
import { failureText, placeFailure } from "./place-errors";
import { usePlaceFlow } from "./use-place-flow";

/** The dialog's height off phones; on a phone the sheet takes part of the screen for each step. */
const dialogHeight = 560;
const phoneSheetHeight = {
  directory: "66%",
  method: "61.5%",
  members: "82.8%",
} as const;

/** The footer bar with the step's buttons. */
const footerHeight = { phone: 56, desktop: 52 } as const;

export function NewConversation(props: {
  layout: Layout;
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const host = useHost();
  const c = colors();
  const phone = () => props.layout === "phone";
  const picker = usePlaceFlow();
  const {
    flow,
    busy,
    cancelling,
    clone,
    cancelClone,
    directory,
    error,
    kind,
    machineName,
    place,
  } = picker;
  const picked = signal<string[] | undefined>(undefined);
  const targetMachineId = () => directory()?.machineId;
  const agentAllowed = (id: string) => {
    const found = host.agent(id);
    return (
      found === undefined || agentAllowedOnMachine(found, targetMachineId())
    );
  };
  const agents = () => {
    const chosen = picked();
    if (chosen !== undefined) return chosen.filter(agentAllowed);
    return host
      .agents()
      .filter((agent) => agentAllowedOnMachine(agent, targetMachineId()))
      .slice(0, 1)
      .map((agent) => agent.id);
  };
  const steward = signal<string | null | undefined>(undefined);
  const currentSteward = () => {
    if (steward() === null) return null;
    const members = agents();
    const chosen = steward();
    if (chosen && members.includes(chosen)) return chosen;
    return members[0];
  };
  const toggleAgent = (id: string) => {
    if (!agentAllowed(id)) return;
    const members = agents();
    const next = members.includes(id)
      ? members.filter((member) => member !== id)
      : [...members, id];
    picked.set(next);
    if (!next.length || (steward() === id && !next.includes(id)))
      steward.set(undefined);
  };
  const saving = signal(false);

  function previous() {
    if (clone()) {
      void cancelClone();
      return;
    }
    if (busy() || saving()) return;
    error.set(undefined);
    if (directory()) {
      directory.set(undefined);
      return;
    }
    const earlier = back(flow());
    if (earlier) flow.set(earlier);
    else props.onClose();
  }

  async function start() {
    const choice = directory();
    if (!choice || agents().length === 0 || saving()) return;
    saving.set(true);
    error.set(undefined);
    try {
      const existing = host
        .projects()
        .find(
          (project) =>
            project.kind === "project" &&
            !project.archived &&
            project.machineId === choice.machineId &&
            (project.id === choice.projectId || project.path === choice.path),
        );
      const project =
        existing ??
        (
          await host.call<ProjectResults["create"]>("projects", "create", {
            machineId: choice.machineId,
            path: choice.path,
          })
        ).project;
      directory.set({ ...choice, projectId: project.id });
      const created = await host.call<ConversationResults["create"]>(
        "conversations",
        "create",
        {
          projectId: project.id,
          agentIds: agents(),
          stewardId: currentSteward(),
        },
      );
      if (host.can("places.remember"))
        void place("remember", {
          machineId: choice.machineId,
          path: choice.path,
        }).catch(() => {});
      props.onClose();
      props.onOpen(created.conversation.id);
    } catch (failure) {
      error.set(placeFailure(failure));
    } finally {
      saving.set(false);
    }
  }

  const methodStage = () =>
    !directory() && (kind() === "method" || kind() === "machine");
  const title = () => {
    if (methodStage() || directory()) return uiText("newConversation");
    switch (kind()) {
      case "search":
        return uiText("searchDirectories");
      case "browse":
        return uiText("browseDirectories");
      case "github":
        return localizedText("Clone from GitHub", "从 GitHub 克隆");
      case "clone-location":
        return localizedText("Clone location", "克隆位置");
      case "new-parent":
        return localizedText("New directory", "新建目录");
      default:
        return localizedText("Directory name", "目录名称");
    }
  };
  const methodEntry = () => methodStage() && flow().pages.length === 1;
  return (
    <Modal
      title={title()}
      phone={phone()}
      sheet={phone()}
      overPhoneNavigation={phone()}
      modalFocus
      stepHeader
      blurBackdrop={props.layout === "desktop"}
      onClose={previous}
      width={dialogWidth.lg}
      height={
        phone()
          ? directory()
            ? phoneSheetHeight.directory
            : methodStage()
              ? phoneSheetHeight.method
              : phoneSheetHeight.members
          : dialogHeight
      }
      panelStyle={
        props.layout === "tablet" && windowSize().width >= 960
          ? { position: "absolute", right: 24, bottom: 38 }
          : undefined
      }
    >
      <If when={methodStage() || directory()}>
        <View
          style={{
            ...row,
            height: space[40],
            flexShrink: 0,
            paddingHorizontal: phone() ? 0 : space[20],
            marginHorizontal: phone() ? space[16] : 0,
            marginTop: phone() ? space[16] : 0,
            gap: space[12],
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <View style={{ ...row, ...grow, gap: space[8] }}>
            <Label tracking="caps" variant="caption" tone="muted">
              {directory() ? "2/2" : "1/2"}
            </Label>
            <Label variant="small" weight={weight.strong}>
              {directory() ? uiText("members") : uiText("directory")}
            </Label>
          </View>
          <Label variant="small" tone="muted">
            {directory()
              ? localizedText("Last step", "最后一步")
              : localizedText("Next: Members", "下一步：成员")}
          </Label>
          <View style={{ ...row, gap: space[4] }}>
            <View
              style={{
                width: space[8],
                height: space[8],
                backgroundColor: directory() ? c().faint : c().ink,
              }}
            />
            <View
              style={{
                width: space[8],
                height: space[8],
                backgroundColor: directory() ? c().ink : undefined,
                borderWidth: directory() ? 0 : 1,
                borderColor: c().strong,
              }}
            />
          </View>
        </View>
      </If>
      <SmoothScroll style={grow} scrollbar={false}>
        <If
          when={directory()}
          else={
            <DirectoryOptions
              picker={picker}
              layout={props.layout}
              title={title()}
            />
          }
        >
          {(target) => (
            <ConversationMembers
              directory={target()}
              machineName={machineName()}
              phone={phone()}
              agentIds={agents()}
              stewardId={currentSteward()}
              onToggleAgent={toggleAgent}
              onSteward={steward.set}
            />
          )}
        </If>
        <If when={error()}>
          {(failure) => (
            <Callout
              tone="danger"
              inline
              title={failureText(failure())}
              description={
                failure().detail && failure().code !== "other"
                  ? failure().detail
                  : undefined
              }
            />
          )}
        </If>
      </SmoothScroll>
      <If when={!phone() && !directory()}>
        <Label
          variant="caption"
          tone="muted"
          style={{
            paddingHorizontal: space[16],
            paddingVertical: space[4],
            borderTopWidth: 1,
            borderColor: c().border,
          }}
        >
          {localizedText(
            "↑↓ to move · Enter to choose · Esc to go back",
            "↑↓ 移动 · Enter 选择 · Esc 返回",
          )}
        </Label>
      </If>
      <View
        style={{
          ...row,
          height: phone() ? footerHeight.phone : footerHeight.desktop,
          justifyContent: "flex-end",
          gap: space[8],
          paddingHorizontal: phone() ? space[16] : space[20],
          borderTopWidth: 1,
          borderColor: c().border,
        }}
      >
        <Button
          label={methodEntry() ? uiText("cancel") : uiText("back")}
          tone="ghost"
          size={control.sm}
          disabled={busy() || saving() || cancelling()}
          onPress={previous}
        />
        <If when={directory()}>
          <Button
            label={localizedText("Start", "开始")}
            tone="primary"
            size={control.sm}
            disabled={!agents().length || !host.can("conversations.create")}
            busy={saving()}
            onPress={() => void start()}
          />
        </If>
      </View>
    </Modal>
  );
}
