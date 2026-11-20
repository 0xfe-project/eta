import type {
  ConversationResults,
  ProjectResults,
} from "@eta/client-contracts";
import type { Layout } from "../../components";
import { back } from "@eta/client-contracts";
import { Scroll, signal, View, windowSize } from "nsh";
import { Button, colors, grow, Label, Modal, row } from "../../components";
import { localizedText, uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { ConversationMembers } from "./conversation-members";
import { DirectoryOptions } from "./directory-options";
import { failureText, placeFailure } from "./place-errors";
import { usePlaceFlow } from "./use-place-flow";

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
  const agents = () =>
    picked() ??
    host
      .agents()
      .slice(0, 1)
      .map((agent) => agent.id);
  const steward = signal<string | null | undefined>(undefined);
  const currentSteward = () =>
    steward() === null ? null : (steward() ?? agents()[0]);
  const toggleAgent = (id: string) => {
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
      width={560}
      height={
        phone()
          ? directory()
            ? "66%"
            : methodStage()
              ? "61.5%"
              : "82.8%"
          : 560
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
            height: 40,
            flexShrink: 0,
            paddingHorizontal: phone() ? 0 : 20,
            marginHorizontal: phone() ? 16 : 0,
            marginTop: phone() ? 16 : 0,
            gap: 12,
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <View style={{ ...row, ...grow, gap: 8 }}>
            <Label size={10} tone="muted" style={{ letterSpacing: 0.8 }}>
              {directory() ? "2/2" : "1/2"}
            </Label>
            <Label size={12} weight={600}>
              {directory() ? uiText("members") : uiText("directory")}
            </Label>
          </View>
          <Label size={12} tone="muted">
            {directory()
              ? localizedText("Last step", "最后一步")
              : localizedText("Next: Members", "下一步：成员")}
          </Label>
          <View style={{ ...row, gap: 4 }}>
            <View
              style={{
                width: 8,
                height: 8,
                backgroundColor: directory() ? c().faint : c().ink,
              }}
            />
            <View
              style={{
                width: 8,
                height: 8,
                backgroundColor: directory() ? c().ink : undefined,
                borderWidth: directory() ? 0 : 1,
                borderColor: c().strong,
              }}
            />
          </View>
        </View>
      </If>
      <Scroll style={grow} scrollbar={false}>
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
            <View role="alert" style={{ padding: 16, gap: 4 }}>
              <Label tone="red">{failureText(failure())}</Label>
              <If when={failure().detail && failure().code !== "other"}>
                <Label tone="muted" size={12}>
                  {failure().detail}
                </Label>
              </If>
            </View>
          )}
        </If>
      </Scroll>
      <If when={!phone() && !directory()}>
        <Label
          size={10}
          tone="muted"
          style={{
            paddingHorizontal: 14,
            paddingVertical: 5,
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
          height: phone() ? 56 : 50,
          justifyContent: "flex-end",
          gap: 8,
          paddingHorizontal: phone() ? 16 : 20,
          borderTopWidth: 1,
          borderColor: c().border,
        }}
      >
        <Button
          label={methodEntry() ? uiText("cancel") : uiText("back")}
          tone="ghost"
          size={24}
          disabled={busy() || saving() || cancelling()}
          onPress={previous}
        />
        <If when={directory()}>
          <Button
            label={localizedText("Start", "开始")}
            tone="primary"
            size={24}
            disabled={
              !agents().length || saving() || !host.can("conversations.create")
            }
            onPress={() => void start()}
          />
        </If>
      </View>
    </Modal>
  );
}
