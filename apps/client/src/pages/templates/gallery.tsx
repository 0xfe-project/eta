import type {
  AgentArgs,
  AgentResults,
  AgentRuntime,
  AgentRuntimeInfo,
  AgentView,
  MachineView,
  PluginView,
} from "@eta/client-contracts";
import type { ScrollRef } from "nsh";
import type { AgentTemplate } from "./template";
import { AGENT_RUNTIMES } from "@eta/client-contracts";
import { cleanup, computed, effect, signal, untracked, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  Field,
  grow,
  Label,
  Markdown,
  Modal,
  row,
  SmoothScroll,
  textFaces,
  textStyle,
} from "../../components";
import { AgentFace } from "../../components/agent-face";
import { BackButton } from "../../components/navigation-buttons";
import {
  avatar,
  control,
  icon,
  opacity,
  space,
  weight,
} from "../../components/tokens";
import { localizedText, uiText } from "../../i18n";
import { follow, useHost } from "../../services/host";
import { problemText } from "../../services/problem-text";
import { CheckControl, ModelSelect, useModels } from "../../ui";
import { useComposioPlugins } from "../plugins/composio-plugins";
import { ConfigurePlugin } from "../plugins/configure";
import { ServersDialog } from "../plugins/servers-panel";
import { pluginSetupModal } from "../settings/agents/plugins";
import {
  askRuntimes,
  reasonText,
  runtimeReason,
} from "../settings/runtimes/status";
import { StatusLine, WarningLine } from "../settings/section";
import { templates, templateSource } from "./catalog";
import {
  fillTemplate,
  findTemplates,
  inferredIntegrations,
  placeholdersOf,
  pluginMatchesIntegration,
  templateCategories,
} from "./template";

/** A row of the template list, fixed so the list can scroll to one by its index. */
const rowHeight = 52;
/** The gallery's dialog: wider than a standard dialog, a list and a detail side by side. */
const galleryWidth = 820;
const galleryHeight = 600;
/** The template list's column on a desktop. */
const galleryListWidth = 300;
/** The phone's bar with its Back, over the list or a template. */
const phoneBarHeight = 48;
/** The editable instructions box height when customizing before import. */
const instructionsEditorHeight = 200;
/** Agent name length cap matching AgentGeneral. */
const agentNameLimit = 100;
/** Instructions length cap matching AgentInstructions. */
const agentInstructionsLimit = 10_000;
/** Width of the runtime picker menu, matching AgentGeneral. */
const runtimeMenuWidth = 260;

export interface TemplateGalleryProps {
  phone: boolean;
  tablet?: boolean;
  /** The template to open on, instead of the first in the list. */
  initialId?: string;
  onClose: () => void;
  /** The agent made from a template. */
  onCreated: (agent: AgentView) => void;
  onModelServices: () => void;
  /** Jump to the Plugins marketplace tab. */
  onOpenMarket?: () => void;
  /** Jump to the Plugins page (optionally on a specific plugin). */
  onOpenPlugins?: (plugin?: string) => void;
}

const categoryName = (category: string) =>
  localizedText(category, templateCategories[category] ?? category);

const builtinRuntimeLabels: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "Pi",
  grok: "Grok Build",
  qwen: "Qwen Code",
};

/**
 * Agents to start from: the role cards of the bundled catalog, searched and filtered by category.
 * One opens to what it owns, what it leaves alone, what it asks first and the instructions it
 * gives, which the reader reads (and may edit) before anything is made; Import makes the agent
 * with those instructions, its name in place of `{NAME}`, the other placeholders filled in,
 * atomic `avatarSeed`, runtime/model selection, and any chosen plugins.
 */
export function TemplateGallery(props: TemplateGalleryProps) {
  const c = colors();
  const host = useHost();
  const type = textFaces();
  const models = useModels();
  const composio = useComposioPlugins();

  follow(() => "agents");
  follow(() => "providers");
  follow(() => (host.can("llm.refresh") ? "llm" : undefined));
  follow(() => "plugins");
  follow(() => "machines");

  const query = signal("");
  const category = signal<string | undefined>(undefined);
  const known = templates.some((template) => template.id === props.initialId);
  const chosenId = signal<string | undefined>(
    known ? props.initialId : undefined,
  );
  const name = signal("");
  const values = signal<Record<string, string>>({});
  const instructionsOverride = signal<string | undefined>(undefined);
  const editingInstructions = signal(false);
  const runtime = signal<AgentRuntime>("eta");
  const machineId = signal<string | null>(null);
  const model = signal("");
  const selectedPlugins = signal<string[]>([]);
  const installedRuntimes = signal<AgentRuntimeInfo[] | null | undefined>(
    undefined,
  );
  const configuringPlugin = signal<string | undefined>(undefined);
  const serversPlugin = signal<string | undefined>(undefined);
  /** Plugin name configured inline: auto-tick once it becomes `ready`. */
  const autoSelectPlugin = signal<string | undefined>(undefined);
  const busy = signal(false);
  const error = signal("");

  const shown = computed(() => findTemplates(templates, query(), category()));
  const chosen = computed(() => {
    const id = chosenId();
    const list = shown();
    // Resolve within the filtered list so searching/switching category never strands a hidden card.
    return (
      list.find((template) => template.id === id) ??
      (props.phone ? undefined : list[0])
    );
  });

  const installedPlugins = () => host.list<PluginView>("plugins");
  const configuringItem = () =>
    installedPlugins().find((item) => item.name === configuringPlugin());
  const serversItem = () =>
    installedPlugins().find((item) => item.name === serversPlugin());

  const machines = () =>
    host
      .list<MachineView>("machines")
      .filter(
        (item) =>
          item.id === machineId() ||
          item.status === "online" ||
          item.status === "offline",
      );

  const runtimeList = () => [
    ...new Set<AgentRuntime>([
      ...AGENT_RUNTIMES,
      ...(installedRuntimes()?.map((item) => item.id) ?? []),
      runtime(),
    ]),
  ];
  const externalRuntime = () =>
    installedRuntimes()?.find((item) => item.id === runtime());
  const availableExternal = () =>
    (installedRuntimes() ?? []).filter((item) => item.status === "available");
  const showRuntimePicker = () =>
    runtime() !== "eta" || availableExternal().length > 0;

  const runtimeLabel = (id: AgentRuntime) =>
    id === "eta"
      ? uiText("etaBuiltIn")
      : (installedRuntimes()?.find((item) => item.id === id)?.label ??
        builtinRuntimeLabels[id] ??
        id);

  const runtimeDisabledReason = (id: AgentRuntime) => {
    if (id === "eta") return undefined;
    const info = installedRuntimes()?.find((item) => item.id === id);
    const reason = info && runtimeReason(info);
    return reason ? uiText(reasonText[reason]) : undefined;
  };

  /** True once provider config has arrived (or host is offline/paused), avoiding premature empty flash. */
  const providersLoaded = () =>
    Boolean(host.state().targets.providers) ||
    host.disconnected() ||
    host.paused();

  const chosenModel = () => {
    if (runtime() !== "eta") return model().trim();
    const list = models();
    const current = model();
    if (current && list.some((entry) => entry.id === current)) return current;
    return list[0]?.id ?? "";
  };

  const canCreate = () =>
    !busy() && (runtime() !== "eta" || Boolean(chosenModel()));

  const existingNames = () =>
    new Set(host.people().map((item) => item.name.trim().toLowerCase()));

  function uniqueNameFor(base: string): string {
    const taken = existingNames();
    const trimmed = base.trim();
    if (!taken.has(trimmed.toLowerCase())) return trimmed;
    let suffix = 2;
    while (taken.has(`${trimmed} ${suffix}`.toLowerCase())) suffix++;
    return `${trimmed} ${suffix}`;
  }

  function effectiveName(template: AgentTemplate): string {
    return name().trim() || uniqueNameFor(template.name);
  }

  function isDuplicateName(): boolean {
    const typed = name().trim();
    return Boolean(typed) && existingNames().has(typed.toLowerCase());
  }

  function renderedInstructions(template: AgentTemplate): string {
    return (
      instructionsOverride() ??
      fillTemplate(template.instructions, effectiveName(template), values())
    );
  }

  function resetDraft(id: string | undefined) {
    chosenId.set(id);
    name.set("");
    values.set({});
    instructionsOverride.set(undefined);
    editingInstructions.set(false);
    error.set("");
  }

  function choose(template: AgentTemplate) {
    resetDraft(template.id);
  }

  function chooseRuntime(next: AgentRuntime) {
    if (runtime() === next) return;
    runtime.set(next);
    model.set("");
  }

  function openPluginSetup(item: PluginView) {
    autoSelectPlugin.set(item.name);
    if (pluginSetupModal(item) === "configure")
      configuringPlugin.set(item.name);
    else serversPlugin.set(item.name);
  }

  // Probe external runtimes when the host supports it.
  effect(() => {
    const machine = machineId();
    if (!host.can("agents.runtimes")) {
      installedRuntimes.set([]);
      return;
    }
    let current = true;
    installedRuntimes.set(undefined);
    cleanup(() => {
      current = false;
    });
    void askRuntimes(host, machine).then(
      (list) => {
        if (current) installedRuntimes.set(list);
      },
      () => {
        if (current) installedRuntimes.set(null);
      },
    );
  });

  // Auto-select a plugin once the user finishes configuring it inline and it becomes ready.
  effect(() => {
    const pending = autoSelectPlugin();
    if (!pending) return;
    const found = installedPlugins().find((item) => item.name === pending);
    if (found?.state === "ready") {
      selectedPlugins.update((list) =>
        list.includes(pending) ? list : [...list, pending],
      );
      autoSelectPlugin.set(undefined);
    }
  });

  let listScroll: ScrollRef | undefined;
  /** Bring `id` into the list's view (rows are `rowHeight` tall). */
  function reveal(id: string | undefined) {
    if (!id) return;
    const index = shown().findIndex((template) => template.id === id);
    if (index > 2)
      listScroll?.scrollTo({ y: (index - 2) * rowHeight, animated: false });
    else if (index >= 0) listScroll?.scrollTo({ y: 0, animated: false });
  }

  // Reactively sync when a new deep link arrives while the gallery is already open.
  let lastInitial = props.initialId;
  effect(() => {
    const next = props.initialId;
    if (next === lastInitial) return;
    lastInitial = next;
    if (!next || !templates.some((template) => template.id === next)) return;
    const visible = findTemplates(
      templates,
      untracked(query),
      untracked(category),
    ).some((template) => template.id === next);
    if (!visible) {
      query.set("");
      category.set(undefined);
    }
    resetDraft(next);
    reveal(next);
  });

  async function create(template: AgentTemplate) {
    const agentName = effectiveName(template);
    if (!canCreate()) return;
    busy.set(true);
    error.set("");
    try {
      const chosenRuntime = runtime();
      const rawModel = chosenModel();
      const finalModel =
        chosenRuntime === "eta"
          ? rawModel
          : rawModel
            ? rawModel.includes(":")
              ? rawModel
              : `${chosenRuntime}:${rawModel}`
            : null;
      const plugins = selectedPlugins();
      const args: AgentArgs["create"] = {
        name: agentName,
        instructions: renderedInstructions(template),
        model: finalModel,
        ...(chosenRuntime !== "eta" ? { runtime: chosenRuntime } : {}),
        ...(machineId() ? { machineId: machineId() } : {}),
        ...(plugins.length ? { plugins } : {}),
        avatarSeed: template.id,
      };
      const { agent } = await host.call<AgentResults["create"]>(
        "agents",
        "create",
        args,
      );
      props.onCreated(agent);
    } catch (cause) {
      error.set(problemText(cause));
    } finally {
      busy.set(false);
    }
  }

  const fieldStyle = () => ({
    height: props.phone ? control.touch : control.md,
    ...textStyle(type("small")),
    paddingHorizontal: space[12],
    borderColor: c().border,
  });

  function toolbar() {
    return (
      <View
        style={{
          gap: space[8],
          padding: space[12],
          borderBottomWidth: 1,
          borderColor: c().border,
        }}
      >
        <Field
          label={localizedText("Search templates", "搜索模版")}
          placeholder={localizedText("Search templates", "搜索模版")}
          value={query()}
          onChange={(value) => query.set(value)}
          style={fieldStyle()}
        />
        <View style={{ ...row, flexWrap: "wrap", gap: space[4] }}>
          <Button
            label={localizedText("All", "全部")}
            tone="ghost"
            size={control.sm}
            selected={!category()}
            style={{ paddingHorizontal: space[8] }}
            onPress={() => category.set(undefined)}
          />
          <Each of={Object.keys(templateCategories)} key={(item) => item}>
            {(item) => (
              <Button
                label={categoryName(item())}
                tone="ghost"
                size={control.sm}
                selected={category() === item()}
                style={{ paddingHorizontal: space[8] }}
                onPress={() =>
                  category.set(category() === item() ? undefined : item())
                }
              />
            )}
          </Each>
        </View>
      </View>
    );
  }

  function list() {
    return (
      <SmoothScroll
        ref={(node) => {
          listScroll = node;
          reveal(props.initialId);
        }}
        style={grow}
        contentStyle={{ paddingVertical: space[4] }}
      >
        <If
          when={shown().length}
          else={
            <Label variant="small" tone="muted" style={{ padding: space[16] }}>
              {localizedText("No template matches.", "没有匹配的模版。")}
            </Label>
          }
        >
          <Each of={shown()} key={(template) => template.id}>
            {(template) => (
              <View
                role="button"
                testID={`template:${template().id}`}
                accessibilityLabel={template().name}
                accessibilityState={{
                  selected: chosen()?.id === template().id,
                }}
                onPress={() => choose(template())}
                hoverStyle={{ backgroundColor: c().surface }}
                style={{
                  ...row,
                  height: rowHeight,
                  gap: space[12],
                  paddingHorizontal: space[12],
                  backgroundColor:
                    chosen()?.id === template().id ? c().selected : undefined,
                  cursor: "pointer",
                }}
              >
                <AgentFace id={template().id} size={avatar.md} />
                <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
                  <Label variant="small" weight={500} lines={1}>
                    {template().name}
                  </Label>
                  <Label variant="caption" tone="muted" lines={1}>
                    {categoryName(template().category)}
                  </Label>
                </View>
              </View>
            )}
          </Each>
        </If>
      </SmoothScroll>
    );
  }

  function points(title: string, items: string[], template: AgentTemplate) {
    return (
      <If when={items.length}>
        <View style={{ gap: space[4] }}>
          <Label variant="small" weight={weight.strong}>
            {title}
          </Label>
          <Markdown
            dense
            value={items
              .map(
                (item) =>
                  `- ${fillTemplate(item, effectiveName(template), values())}`,
              )
              .join("\n")}
          />
        </View>
      </If>
    );
  }

  function pluginsSection(template: AgentTemplate) {
    const integrations = inferredIntegrations(template);
    const composioVisible = () => composio.list();
    const totalAvailable = () =>
      installedPlugins().length + composioVisible().length;
    const isRecommended = (pluginName: string) =>
      integrations.some((slug) => pluginMatchesIntegration(pluginName, slug));
    const missingIntegrations = () =>
      integrations.filter(
        (slug) =>
          !installedPlugins().some((item) =>
            pluginMatchesIntegration(item.name, slug),
          ) &&
          !composioVisible().some((item) =>
            pluginMatchesIntegration(item.name, slug),
          ),
      );
    const sortedInstalled = () =>
      [...installedPlugins()].sort(
        (a, b) => Number(isRecommended(b.name)) - Number(isRecommended(a.name)),
      );
    const sortedComposio = () =>
      [...composioVisible()].sort(
        (a, b) => Number(isRecommended(b.name)) - Number(isRecommended(a.name)),
      );
    const showSection = () =>
      totalAvailable() > 0 ||
      integrations.length > 0 ||
      Boolean(props.onOpenMarket);

    return (
      <If when={showSection()}>
        <View style={{ gap: space[8], paddingTop: space[4] }}>
          <View style={{ ...row, gap: space[8] }}>
            <Label variant="small" weight={weight.strong} style={{ flex: 1 }}>
              {localizedText("Plugins & tools", "插件与工具")}
            </Label>
            <If when={props.onOpenMarket}>
              <Button
                label={uiText("browseMarket")}
                tone="ghost"
                size={control.sm}
                style={{ paddingHorizontal: space[8] }}
                onPress={() => props.onOpenMarket?.()}
              />
            </If>
          </View>
          <If when={missingIntegrations().length}>
            <Label variant="caption" tone="muted">
              {localizedText(
                `Suggested for this role: ${missingIntegrations().join(", ")}`,
                `该角色建议搭配：${missingIntegrations().join("、")}`,
              )}
            </Label>
          </If>
          <If when={totalAvailable()}>
            <View
              style={{
                borderWidth: 1,
                borderColor: c().border,
                backgroundColor: c().surface,
              }}
            >
              <Each of={sortedInstalled()} key={(item) => item.name}>
                {(item) => {
                  const checked = () => selectedPlugins().includes(item().name);
                  const ready = () =>
                    item().enabled && item().state === "ready";
                  const needsSetup = () =>
                    item().enabled && item().state === "needs_config";
                  const recommended = () => isRecommended(item().name);
                  return (
                    <View
                      style={{
                        ...row,
                        alignItems: "center",
                        paddingHorizontal: space[12],
                        paddingVertical: space[8],
                        gap: space[8],
                        borderBottomWidth: 1,
                        borderColor: c().border,
                        opacity: item().enabled ? 1 : opacity.muted,
                      }}
                    >
                      <CheckControl
                        label={item().name}
                        checked={checked()}
                        disabled={!ready() && !checked()}
                        onChange={(enabled) =>
                          selectedPlugins.update((current) =>
                            enabled
                              ? [...new Set([...current, item().name])]
                              : current.filter(
                                  (entry) => entry !== item().name,
                                ),
                          )
                        }
                        size={icon.md}
                        markSize={icon.sm}
                        style={{
                          ...row,
                          flex: 1,
                          minWidth: 0,
                          alignItems: "center",
                          gap: space[8],
                          cursor: ready() || checked() ? "pointer" : "default",
                        }}
                      >
                        <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
                          <View style={{ ...row, gap: space[8] }}>
                            <Label variant="small" lines={1}>
                              {item().name}
                            </Label>
                            <If when={recommended()}>
                              <Label variant="caption" tone="muted">
                                {localizedText("Recommended", "推荐")}
                              </Label>
                            </If>
                          </View>
                          <If when={!item().enabled}>
                            <StatusLine
                              status={{
                                label: uiText("pluginOffForAll"),
                                color: c().faint,
                              }}
                            />
                          </If>
                          <If when={needsSetup()}>
                            <StatusLine
                              status={{
                                label: uiText("pluginNeedsSetup"),
                                color: c().warning,
                              }}
                            />
                          </If>
                        </View>
                      </CheckControl>
                      <If when={needsSetup()}>
                        <Button
                          label={uiText("configure")}
                          size={control.sm}
                          style={{ paddingHorizontal: space[8], flexShrink: 0 }}
                          onPress={() => openPluginSetup(item())}
                        />
                      </If>
                    </View>
                  );
                }}
              </Each>
              <Each of={sortedComposio()} key={(item) => item.name}>
                {(item) => {
                  const checked = () => selectedPlugins().includes(item().name);
                  const usable = () =>
                    item().enabled &&
                    item().state === "ready" &&
                    runtime() === "eta";
                  const recommended = () => isRecommended(item().name);
                  return (
                    <CheckControl
                      label={item().name}
                      checked={checked()}
                      disabled={!usable() && !checked()}
                      onChange={(enabled) =>
                        selectedPlugins.update((current) =>
                          enabled
                            ? [...new Set([...current, item().name])]
                            : current.filter((entry) => entry !== item().name),
                        )
                      }
                      size={icon.md}
                      markSize={icon.sm}
                      style={{
                        ...row,
                        alignItems: "center",
                        paddingHorizontal: space[12],
                        paddingVertical: space[8],
                        gap: space[8],
                        borderBottomWidth: 1,
                        borderColor: c().border,
                        cursor: usable() || checked() ? "pointer" : "default",
                        opacity: item().enabled ? 1 : opacity.muted,
                      }}
                    >
                      <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
                        <View style={{ ...row, gap: space[8] }}>
                          <Label variant="small" lines={1}>
                            {item().name}
                          </Label>
                          <If when={recommended()}>
                            <Label variant="caption" tone="muted">
                              {localizedText("Recommended", "推荐")}
                            </Label>
                          </If>
                        </View>
                        <Label variant="caption" tone="muted">
                          {uiText("composioToolkit")}
                        </Label>
                      </View>
                    </CheckControl>
                  );
                }}
              </Each>
            </View>
          </If>
        </View>
      </If>
    );
  }

  function detail(template: AgentTemplate) {
    const placeholders = placeholdersOf(template.instructions);
    return (
      <SmoothScroll
        style={grow}
        contentStyle={{ padding: space[16], gap: space[12] }}
      >
        <View style={{ ...row, gap: space[12] }}>
          <AgentFace id={template.id} size={avatar.xl} />
          <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
            <Label variant="subtitle" weight={weight.strong}>
              {template.name}
            </Label>
            <Label variant="small" tone="muted">
              {template.note
                ? `${categoryName(template.category)} · ${template.note}`
                : categoryName(template.category)}
            </Label>
          </View>
        </View>
        <Label variant="small">{template.summary}</Label>
        {points(localizedText("Owns", "负责"), template.owns, template)}
        {points(
          localizedText("Leaves alone", "不负责"),
          template.doesNotOwn,
          template,
        )}
        {points(
          localizedText("Asks you first", "需要你批准"),
          template.needsApproval,
          template,
        )}
        <View style={{ gap: space[4] }}>
          <View style={{ ...row, gap: space[8] }}>
            <Label variant="small" weight={weight.strong} style={{ flex: 1 }}>
              {localizedText("Instructions it gets", "它会拿到的指令")}
            </Label>
            <If when={instructionsOverride() !== undefined}>
              <Button
                label={localizedText("Reset", "重置")}
                tone="ghost"
                size={control.sm}
                style={{ paddingHorizontal: space[8] }}
                onPress={() => instructionsOverride.set(undefined)}
              />
            </If>
            <Button
              label={
                editingInstructions()
                  ? localizedText("Preview", "预览")
                  : localizedText("Edit", "编辑")
              }
              tone="ghost"
              size={control.sm}
              style={{ paddingHorizontal: space[8] }}
              onPress={() => editingInstructions.set(!editingInstructions())}
            />
          </View>
          <If
            when={editingInstructions()}
            else={
              <View
                testID="template-instructions"
                style={{
                  padding: space[12],
                  borderWidth: 1,
                  borderColor: c().border,
                  backgroundColor: c().surface,
                }}
              >
                <Markdown dense value={renderedInstructions(template)} />
              </View>
            }
          >
            <Field
              label={localizedText("Instructions it gets", "它会拿到的指令")}
              multiline
              maxLength={agentInstructionsLimit}
              value={renderedInstructions(template)}
              onChange={(value) => instructionsOverride.set(value)}
              style={{
                height: instructionsEditorHeight,
                ...textStyle(type("small"), "prose"),
                padding: space[12],
                borderColor: c().strong,
              }}
            />
          </If>
        </View>
        <View
          style={{
            gap: space[8],
            paddingTop: space[12],
            borderTopWidth: 1,
            borderColor: c().border,
          }}
        >
          <Label variant="small" weight={weight.strong}>
            {localizedText("Name", "名字")}
          </Label>
          <Field
            label={localizedText("Name", "名字")}
            placeholder={uniqueNameFor(template.name)}
            maxLength={agentNameLimit}
            value={name()}
            onChange={(value) => name.set(value)}
            style={fieldStyle()}
          />
          <If when={isDuplicateName()}>
            <View style={{ ...row, gap: space[8] }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <WarningLine
                  text={localizedText(
                    `An agent named "${name().trim()}" already exists.`,
                    `已存在名为“${name().trim()}”的智能体。`,
                  )}
                />
              </View>
              <Button
                label={localizedText("Use unique name", "使用不重名名称")}
                tone="ghost"
                size={control.sm}
                style={{ paddingHorizontal: space[8], flexShrink: 0 }}
                onPress={() => name.set(uniqueNameFor(name().trim()))}
              />
            </View>
          </If>
          <If when={placeholders.length}>
            <Label variant="small" tone="muted">
              {localizedText(
                "Fill in what you know now; the rest stays in the instructions to change later.",
                "能填的先填，没填的会原样留在指令里，之后可以再改。",
              )}
            </Label>
            <Each of={placeholders} key={(key) => key}>
              {(key) => (
                <Field
                  label={key()}
                  placeholder={`{${key()}}`}
                  value={values()[key()] ?? ""}
                  onChange={(value) =>
                    values.set({ ...values(), [key()]: value })
                  }
                  style={fieldStyle()}
                />
              )}
            </Each>
          </If>
          <If when={machines().length > 1}>
            <Label variant="small" weight={weight.strong}>
              {uiText("runsOn")}
            </Label>
            <ActionMenu
              label={uiText("runsOn")}
              value={
                machines().find((item) => item.id === machineId())?.name ??
                uiText("followProject")
              }
              triggerStyle={fieldStyle()}
            >
              <ActionItem
                label={uiText("followProject")}
                checked={!machineId()}
                onSelect={() => machineId.set(null)}
              />
              <Each of={machines()} key={(item) => item.id}>
                {(item) => (
                  <ActionItem
                    label={item().name}
                    checked={machineId() === item().id}
                    onSelect={() => machineId.set(item().id)}
                  />
                )}
              </Each>
            </ActionMenu>
          </If>
          <If when={showRuntimePicker()}>
            <Label variant="small" weight={weight.strong}>
              {uiText("runtime")}
            </Label>
            <ActionMenu
              label={uiText("runtime")}
              value={runtimeLabel(runtime())}
              triggerStyle={fieldStyle()}
              popupWidth={runtimeMenuWidth}
            >
              <Each of={runtimeList()}>
                {(item) => (
                  <ActionItem
                    label={runtimeLabel(item())}
                    detail={runtimeDisabledReason(item())}
                    disabled={
                      !!runtimeDisabledReason(item()) && runtime() !== item()
                    }
                    checked={runtime() === item()}
                    onSelect={() => chooseRuntime(item())}
                  />
                )}
              </Each>
            </ActionMenu>
          </If>
          <Label variant="small" weight={weight.strong}>
            {localizedText("Model", "模型")}
          </Label>
          <If
            when={runtime() === "eta"}
            else={
              <If
                when={externalRuntime()?.models.length}
                else={
                  <Field
                    label={uiText("model")}
                    placeholder={uiText("runtimeDefault")}
                    value={model()}
                    onChange={(value) => model.set(value)}
                    style={fieldStyle()}
                  />
                }
              >
                <ActionMenu
                  label={uiText("model")}
                  value={
                    externalRuntime()?.models.find(
                      (entry) => `${runtime()}:${entry.id}` === model(),
                    )?.name ||
                    model() ||
                    uiText("runtimeDefault")
                  }
                  triggerStyle={fieldStyle()}
                >
                  <ActionItem
                    label={uiText("runtimeDefault")}
                    checked={!model()}
                    onSelect={() => model.set("")}
                  />
                  <Each
                    of={externalRuntime()?.models ?? []}
                    key={(entry) => entry.id}
                  >
                    {(entry) => (
                      <ActionItem
                        label={entry().name}
                        checked={`${runtime()}:${entry().id}` === model()}
                        onSelect={() => model.set(`${runtime()}:${entry().id}`)}
                      />
                    )}
                  </Each>
                </ActionMenu>
              </If>
            }
          >
            <If
              when={models().length}
              else={
                <If
                  when={providersLoaded()}
                  else={
                    <Label variant="small" tone="muted">
                      {localizedText("Loading models…", "正在加载模型…")}
                    </Label>
                  }
                >
                  <View style={{ ...row, gap: space[8] }}>
                    <Label variant="small" tone="muted" style={{ flex: 1 }}>
                      {localizedText(
                        "Add a model service first.",
                        "先添加一个模型服务。",
                      )}
                    </Label>
                    <Button
                      label={localizedText("Model services", "模型服务")}
                      size={control.md}
                      style={{ paddingHorizontal: space[12] }}
                      onPress={props.onModelServices}
                    />
                  </View>
                </If>
              }
            >
              <ModelSelect value={chosenModel()} onChange={model.set} />
            </If>
          </If>
          {pluginsSection(template)}
          <If when={error()}>
            <Label variant="small" tone="red">
              {error()}
            </Label>
          </If>
          <View style={{ ...row, gap: space[8] }}>
            <Label variant="caption" tone="muted" style={{ flex: 1 }}>
              {localizedText(
                `From ${templateSource.repo} · ${templateSource.license}`,
                `来自 ${templateSource.repo} · ${templateSource.license}`,
              )}
            </Label>
            <Button
              label={
                busy()
                  ? localizedText("Importing…", "正在导入…")
                  : localizedText("Import", "导入")
              }
              tone="primary"
              size={props.phone ? control.touch : control.md}
              disabled={!canCreate()}
              style={{ paddingHorizontal: space[12] }}
              onPress={() => void create(template)}
            />
          </View>
        </View>
      </SmoothScroll>
    );
  }

  /** The chosen template's detail, made again for another one (and scrolled back to its top). */
  function chosenDetail() {
    return (
      <If
        when={chosen()}
        else={
          <Label variant="small" tone="muted" style={{ padding: space[16] }}>
            {localizedText("No template matches.", "没有匹配的模版。")}
          </Label>
        }
      >
        <Each of={chosen() ? [chosen()!] : []} key={(template) => template.id}>
          {(template) => detail(template())}
        </Each>
      </If>
    );
  }

  return (
    <Modal
      title={localizedText("Agent templates", "智能体模版")}
      phone={props.phone}
      phonePage={props.phone}
      overPhoneNavigation={props.phone}
      width={galleryWidth}
      height={props.phone ? "100%" : galleryHeight}
      modalFocus
      hideHeader={props.phone}
      dismissible={!busy()}
      onClose={props.onClose}
    >
      <If
        when={props.phone}
        else={
          <View style={{ ...grow, flexDirection: "row" }}>
            <View
              style={{
                width: galleryListWidth,
                borderRightWidth: 1,
                borderColor: c().border,
              }}
            >
              {toolbar()}
              {list()}
            </View>
            <View style={grow}>{chosenDetail()}</View>
          </View>
        }
      >
        <View style={grow}>
          {/* One Back: from a template to the list, from the list out. */}
          <View
            style={{
              ...row,
              height: phoneBarHeight,
              gap: space[4],
              paddingHorizontal: space[4],
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <BackButton
              size={control.touch}
              iconSize={icon.md}
              disabled={busy()}
              onPress={() =>
                chosen() ? chosenId.set(undefined) : props.onClose()
              }
            />
            <Label weight={weight.strong} lines={1} style={{ flex: 1 }}>
              {chosen()?.name ?? localizedText("Agent templates", "智能体模版")}
            </Label>
          </View>
          <If
            when={chosen()}
            else={
              <>
                {toolbar()}
                {list()}
              </>
            }
          >
            {chosenDetail()}
          </If>
        </View>
      </If>
      <If when={configuringItem()}>
        {(item) => (
          <ConfigurePlugin
            item={item()}
            phone={props.phone}
            tablet={Boolean(props.tablet)}
            onClose={() => configuringPlugin.set(undefined)}
            onServers={() => {
              const pluginName = item().name;
              configuringPlugin.set(undefined);
              serversPlugin.set(pluginName);
            }}
          />
        )}
      </If>
      <If when={serversItem()}>
        {(item) => (
          <ServersDialog
            item={item()}
            phone={props.phone}
            onClose={() => serversPlugin.set(undefined)}
          />
        )}
      </If>
    </Modal>
  );
}
