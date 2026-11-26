import type {
  AgentArgs,
  AgentResults,
  AgentRuntime,
  AgentRuntimeInfo,
  AgentView,
  MachineView,
  PluginBundledAgentView,
  PluginView,
  ThinkingLevel,
} from "@eta/client-contracts";
import type { ScrollRef } from "nsh";
import type { ImportedBotDraft, LocalBotSourceKind } from "./local-import";
import type { AgentTemplate } from "./template";
import { AGENT_RUNTIMES, THINKING_LEVELS } from "@eta/client-contracts";
import {
  cleanup,
  computed,
  effect,
  Picker,
  signal,
  untracked,
  View,
} from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  dialogWidth,
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
import { LOCAL_BOT_MAX_BYTES, parseLocalBot } from "./local-import";
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
/** Multiline paste input height in the local import dialog. */
const pasteInputHeight = 200;
/** Agent name length cap matching AgentGeneral. */
const agentNameLimit = 100;
/** Instructions length cap matching AgentInstructions. */
const agentInstructionsLimit = 10_000;
/** Width of the runtime picker menu, matching AgentGeneral. */
const runtimeMenuWidth = 260;

const PLUGIN_AGENTS_CATEGORY = "From plugins";
const LOCAL_CATEGORY = "Local";

interface GalleryEntry {
  template: AgentTemplate;
  kind: "catalog" | "plugin" | "local";
  pluginName?: string;
  draft?: ImportedBotDraft;
}

/** Convert a plugin-bundled agent definition into an `ImportedBotDraft` for `TemplateGallery`. */
export function pluginBundledAgentDraft(
  pluginName: string,
  agent: PluginBundledAgentView,
): ImportedBotDraft {
  return {
    sourceKind: "markdown-agent",
    filename: agent.path,
    template: {
      id: `plugin:${pluginName}:${agent.id}`,
      name: agent.name,
      category: PLUGIN_AGENTS_CATEGORY,
      summary: agent.description,
      owns: [],
      doesNotOwn: [],
      needsApproval: [],
      instructions: agent.instructions,
      recommendedPlugins: [pluginName],
    },
    plugins: [pluginName],
  };
}

export interface TemplateGalleryProps {
  phone: boolean;
  tablet?: boolean;
  /** The template to open on, instead of the first in the list. */
  initialId?: string;
  /** A pre-loaded local or plugin-bundled bot draft to open directly on. */
  initialDraft?: ImportedBotDraft;
  onClose: () => void;
  /** The agent made from a template. */
  onCreated: (agent: AgentView) => void;
  onModelServices: () => void;
  /** Jump to the Plugins marketplace tab. */
  onOpenMarket?: () => void;
  /** Jump to the Plugins page (optionally on a specific plugin). */
  onOpenPlugins?: (plugin?: string) => void;
}

const categoryName = (category: string) => {
  if (category === PLUGIN_AGENTS_CATEGORY)
    return localizedText("From plugins", "来自插件");
  if (category === LOCAL_CATEGORY)
    return localizedText("Local import", "本地导入");
  return localizedText(category, templateCategories[category] ?? category);
};

const sourceKindLabel = (kind: LocalBotSourceKind) => {
  switch (kind) {
    case "json":
      return "JSON";
    case "yaml":
      return "YAML";
    case "markdown-agent":
      return "Markdown";
    case "role-card":
      return localizedText("Role card", "角色卡");
  }
};

function entryFromDraft(draft: ImportedBotDraft): GalleryEntry {
  const pluginName =
    draft.template.category === PLUGIN_AGENTS_CATEGORY
      ? draft.plugins?.[0]
      : undefined;
  return pluginName
    ? { template: draft.template, kind: "plugin", pluginName, draft }
    : { template: draft.template, kind: "local", draft };
}

function usesTemplatePlaceholders(entry: GalleryEntry): boolean {
  return entry.kind === "catalog" || entry.draft?.sourceKind === "role-card";
}

function matchesEntry(
  entry: GalleryEntry,
  q: string,
  cat: string | undefined,
): boolean {
  if (cat && entry.template.category !== cat) return false;
  if (!q.trim()) return true;
  if (findTemplates([entry.template], q, cat).length > 0) return true;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = [
    entry.template.name,
    entry.template.summary,
    entry.template.category,
    categoryName(entry.template.category),
    entry.pluginName ?? "",
    entry.draft?.filename ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

const builtinRuntimeLabels: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "Pi",
  grok: "Grok Build",
  qwen: "Qwen Code",
};

/**
 * Agents to start from: the role cards of the bundled catalog, plugin-bundled agents, and local
 * bot definitions (file or paste), searched and filtered by category. One opens to what it owns,
 * what it leaves alone, what it asks first and the instructions it gives, which the reader reads
 * (and may edit) before anything is made; Import makes the agent with those instructions, its name
 * in place of `{NAME}`, the other placeholders filled in, atomic `avatarSeed`, runtime/model
 * selection, and any chosen plugins.
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
  const importedDrafts = signal<ImportedBotDraft[]>(
    props.initialDraft ? [props.initialDraft] : [],
  );
  const initialSelectedId = () => {
    if (props.initialDraft) return props.initialDraft.template.id;
    if (
      props.initialId &&
      templates.some((template) => template.id === props.initialId)
    )
      return props.initialId;
    return undefined;
  };
  const chosenId = signal<string | undefined>(initialSelectedId());
  const name = signal("");
  const values = signal<Record<string, string>>({});
  const instructionsOverride = signal<string | undefined>(undefined);
  const editingInstructions = signal(false);
  const runtime = signal<AgentRuntime>("eta");
  const machineId = signal<string | null>(null);
  const model = signal("");
  const thinkingLevel = signal<ThinkingLevel | null>(null);
  const persona = signal("");
  const selectedPlugins = signal<string[]>([]);
  /** Requested plugins from a draft not yet seen in `installedPlugins`; auto-ticked if ready on arrival. */
  const pendingPlugins = signal<string[]>([]);
  const installedRuntimes = signal<AgentRuntimeInfo[] | null | undefined>(
    undefined,
  );
  const configuringPlugin = signal<string | undefined>(undefined);
  const serversPlugin = signal<string | undefined>(undefined);
  /** Plugin name configured inline: auto-tick once it becomes `ready`. */
  const autoSelectPlugin = signal<string | undefined>(undefined);
  const busy = signal(false);
  const error = signal("");
  const importError = signal("");
  const pasteOpen = signal(false);
  const pasteFilename = signal("");
  const pasteText = signal("");
  const pasteError = signal("");

  const installedPlugins = () => host.list<PluginView>("plugins");
  const configuringItem = () =>
    installedPlugins().find((item) => item.name === configuringPlugin());
  const serversItem = () =>
    installedPlugins().find((item) => item.name === serversPlugin());

  const pluginEntries = computed<GalleryEntry[]>(() =>
    installedPlugins().flatMap((plugin) =>
      (plugin.bundledAgents ?? []).map((agent) => {
        const draft = pluginBundledAgentDraft(plugin.name, agent);
        return {
          template: draft.template,
          kind: "plugin" as const,
          pluginName: plugin.name,
          draft,
        };
      }),
    ),
  );

  const allEntries = computed<GalleryEntry[]>(() => {
    const seen = new Set<string>();
    const out: GalleryEntry[] = [];
    const pushUnique = (entry: GalleryEntry) => {
      if (seen.has(entry.template.id)) return;
      seen.add(entry.template.id);
      out.push(entry);
    };
    for (const draft of importedDrafts()) pushUnique(entryFromDraft(draft));
    for (const entry of pluginEntries()) pushUnique(entry);
    for (const template of templates) pushUnique({ template, kind: "catalog" });
    return out;
  });

  const filterCategories = computed(() => {
    const entries = allEntries();
    const hasLocal = entries.some(
      (entry) => entry.template.category === LOCAL_CATEGORY,
    );
    const hasPlugin = entries.some(
      (entry) => entry.template.category === PLUGIN_AGENTS_CATEGORY,
    );
    return [
      ...(hasLocal ? [LOCAL_CATEGORY] : []),
      ...(hasPlugin ? [PLUGIN_AGENTS_CATEGORY] : []),
      ...Object.keys(templateCategories),
    ];
  });

  const shown = computed(() =>
    allEntries().filter((entry) => matchesEntry(entry, query(), category())),
  );
  const chosen = computed(() => {
    const id = chosenId();
    const list = shown();
    // Resolve within the filtered list so searching/switching category never strands a hidden card.
    return (
      list.find((entry) => entry.template.id === id) ??
      (props.phone ? undefined : list[0])
    );
  });

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

  function renderedInstructions(entry: GalleryEntry): string {
    const override = instructionsOverride();
    if (override !== undefined) return override;
    if (!usesTemplatePlaceholders(entry)) return entry.template.instructions;
    return fillTemplate(
      entry.template.instructions,
      effectiveName(entry.template),
      values(),
    );
  }

  function readyPluginNames(): Set<string> {
    const ready = new Set<string>();
    for (const item of installedPlugins()) {
      if (item.enabled && item.state === "ready") ready.add(item.name);
    }
    for (const item of composio.list()) {
      if (item.enabled && item.state === "ready") ready.add(item.name);
    }
    return ready;
  }

  function requestedPluginsOf(entry: GalleryEntry): string[] {
    if (entry.draft?.plugins?.length) return entry.draft.plugins;
    if (entry.pluginName) return [entry.pluginName];
    return [];
  }

  let appliedId: string | undefined;

  function applyEntry(entry: GalleryEntry) {
    const draft = entry.draft;
    const nextRuntime: AgentRuntime = draft?.runtime ?? "eta";
    const rawModel = draft?.model ?? "";
    const nextModel =
      nextRuntime !== "eta" && rawModel && !rawModel.includes(":")
        ? `${nextRuntime}:${rawModel}`
        : rawModel;
    const requested = requestedPluginsOf(entry);
    const ready = readyPluginNames();
    const preselected = requested.filter((item) => ready.has(item));
    const installedNames = new Set([
      ...installedPlugins().map((item) => item.name),
      ...composio.list().map((item) => item.name),
    ]);
    const waiting = requested.filter(
      (item) => !ready.has(item) && !installedNames.has(item),
    );

    appliedId = entry.template.id;
    chosenId.set(entry.template.id);
    name.set(entry.kind === "catalog" ? "" : entry.template.name);
    values.set({});
    instructionsOverride.set(undefined);
    editingInstructions.set(false);
    runtime.set(nextRuntime);
    model.set(nextModel);
    thinkingLevel.set(draft?.thinkingLevel ?? null);
    machineId.set(draft?.machineId ?? null);
    persona.set(draft?.persona ?? "");
    selectedPlugins.set([...new Set(preselected)]);
    pendingPlugins.set([...new Set(waiting)]);
    autoSelectPlugin.set(undefined);
    error.set("");
  }

  function choose(entry: GalleryEntry) {
    applyEntry(entry);
  }

  function loadDraft(draft: ImportedBotDraft) {
    importedDrafts.update((list) => [
      draft,
      ...list.filter((item) => item.template.id !== draft.template.id),
    ]);
    const entry = entryFromDraft(draft);
    if (!matchesEntry(entry, untracked(query), untracked(category))) {
      query.set("");
      category.set(undefined);
    }
    importError.set("");
    applyEntry(entry);
    reveal(entry.template.id);
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

  async function pickLocalBotFile() {
    importError.set("");
    try {
      const chosenFiles = await Picker.pickFiles({
        multiple: false,
        filters: [
          {
            name: localizedText("Bot files", "智能体文件"),
            extensions: ["md", "markdown", "yaml", "yml", "json"],
          },
        ],
        maxSize: LOCAL_BOT_MAX_BYTES,
      });
      const item = chosenFiles[0];
      if (!item) return;
      if (item.status === "tooLarge" || !item.file) {
        importError.set(
          localizedText(
            `File "${item.name}" exceeds the ${LOCAL_BOT_MAX_BYTES / 1024} KiB limit.`,
            `文件“${item.name}”超过 ${LOCAL_BOT_MAX_BYTES / 1024} KiB 限制。`,
          ),
        );
        return;
      }
      const text = await item.file.text();
      const parsed = parseLocalBot(text, item.name);
      if (!parsed.ok) {
        importError.set(parsed.error);
        return;
      }
      loadDraft(parsed.draft);
    } catch (cause) {
      importError.set(problemText(cause));
    }
  }

  function closePaste() {
    pasteOpen.set(false);
    pasteFilename.set("");
    pasteText.set("");
    pasteError.set("");
  }

  function submitPaste() {
    const parsed = parseLocalBot(
      pasteText(),
      pasteFilename().trim() || undefined,
    );
    if (!parsed.ok) {
      pasteError.set(parsed.error);
      return;
    }
    closePaste();
    loadDraft(parsed.draft);
  }

  // Keep form fields synced whenever the active chosen entry changes (e.g. initial open or filter change).
  effect(() => {
    const current = chosen();
    if (!current) {
      appliedId = undefined;
      return;
    }
    if (current.template.id === appliedId) return;
    untracked(() => applyEntry(current));
  });

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

  // Auto-select pending requested plugins once the host's plugins list arrives and they are ready.
  effect(() => {
    const waiting = pendingPlugins();
    if (!waiting.length) return;
    const list = installedPlugins();
    const comp = runtime() === "eta" ? composio.list() : [];
    if (!list.length && !comp.length) return;
    const remaining: string[] = [];
    const toSelect: string[] = [];
    for (const pluginName of waiting) {
      const found =
        list.find((item) => item.name === pluginName) ??
        comp.find((item) => item.name === pluginName);
      if (!found) {
        remaining.push(pluginName);
      } else if (found.enabled && found.state === "ready") {
        toSelect.push(pluginName);
      }
    }
    if (toSelect.length) {
      selectedPlugins.update((current) => [
        ...new Set([...current, ...toSelect]),
      ]);
    }
    if (remaining.length !== waiting.length) {
      pendingPlugins.set(remaining);
    }
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
    const index = shown().findIndex((entry) => entry.template.id === id);
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
    if (!next) return;
    const match = untracked(allEntries).find(
      (entry) => entry.template.id === next,
    );
    if (!match) return;
    if (!matchesEntry(match, untracked(query), untracked(category))) {
      query.set("");
      category.set(undefined);
    }
    applyEntry(match);
    reveal(next);
  });

  // Reactively load when a new `initialDraft` prop arrives while the gallery is open.
  let lastInitialDraft = props.initialDraft;
  effect(() => {
    const next = props.initialDraft;
    if (next === lastInitialDraft) return;
    lastInitialDraft = next;
    if (!next) return;
    untracked(() => loadDraft(next));
  });

  async function create(entry: GalleryEntry) {
    const template = entry.template;
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
      const ready = readyPluginNames();
      const plugins = selectedPlugins().filter((pluginName) =>
        ready.has(pluginName),
      );
      const trimmedPersona = persona().trim();
      const args: AgentArgs["create"] = {
        name: agentName,
        instructions: renderedInstructions(entry),
        model: finalModel,
        ...(chosenRuntime !== "eta" ? { runtime: chosenRuntime } : {}),
        ...(trimmedPersona ? { persona: trimmedPersona } : {}),
        ...(thinkingLevel() ? { thinkingLevel: thinkingLevel() } : {}),
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
        <View style={{ ...row, gap: space[4] }}>
          <Button
            label={localizedText("Import file", "导入文件")}
            icon="file"
            tone="ghost"
            size={control.sm}
            style={{ gap: space[4], paddingHorizontal: space[8] }}
            onPress={() => void pickLocalBotFile()}
          />
          <Button
            label={localizedText("Paste", "粘贴")}
            icon="copy"
            tone="ghost"
            size={control.sm}
            style={{ gap: space[4], paddingHorizontal: space[8] }}
            onPress={() => {
              pasteError.set("");
              pasteOpen.set(true);
            }}
          />
        </View>
        <If when={importError()}>
          <Label variant="caption" tone="red">
            {importError()}
          </Label>
        </If>
        <View style={{ ...row, flexWrap: "wrap", gap: space[4] }}>
          <Button
            label={localizedText("All", "全部")}
            tone="ghost"
            size={control.sm}
            selected={!category()}
            style={{ paddingHorizontal: space[8] }}
            onPress={() => category.set(undefined)}
          />
          <Each of={filterCategories()} key={(item) => item}>
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

  function listRowSubtitle(entry: GalleryEntry): string {
    if (entry.kind === "plugin" && entry.pluginName) {
      return `${localizedText("Plugin", "插件")} · ${entry.pluginName}`;
    }
    if (entry.kind === "local" && entry.draft) {
      const badge = sourceKindLabel(entry.draft.sourceKind);
      return entry.draft.filename
        ? `${badge} · ${entry.draft.filename}`
        : badge;
    }
    return categoryName(entry.template.category);
  }

  function list() {
    return (
      <SmoothScroll
        ref={(node) => {
          listScroll = node;
          reveal(props.initialDraft?.template.id ?? props.initialId);
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
          <Each of={shown()} key={(entry) => entry.template.id}>
            {(entry) => (
              <View
                role="button"
                testID={`template:${entry().template.id}`}
                accessibilityLabel={entry().template.name}
                accessibilityState={{
                  selected: chosen()?.template.id === entry().template.id,
                }}
                onPress={() => choose(entry())}
                hoverStyle={{ backgroundColor: c().surface }}
                style={{
                  ...row,
                  height: rowHeight,
                  gap: space[12],
                  paddingHorizontal: space[12],
                  backgroundColor:
                    chosen()?.template.id === entry().template.id
                      ? c().selected
                      : undefined,
                  cursor: "pointer",
                }}
              >
                <AgentFace id={entry().template.id} size={avatar.md} />
                <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
                  <Label variant="small" weight={500} lines={1}>
                    {entry().template.name}
                  </Label>
                  <Label variant="caption" tone="muted" lines={1}>
                    {listRowSubtitle(entry())}
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

  function pluginsSection(entry: GalleryEntry) {
    const template = entry.template;
    const requested = requestedPluginsOf(entry);
    const requestedSet = new Set(requested);
    const integrations = inferredIntegrations(template);
    const composioVisible = () => composio.list();
    const totalAvailable = () =>
      installedPlugins().length + composioVisible().length;
    const isRequested = (pluginName: string) => requestedSet.has(pluginName);
    const isRecommended = (pluginName: string) =>
      isRequested(pluginName) ||
      integrations.some((slug) => pluginMatchesIntegration(pluginName, slug));
    const rankOf = (pluginName: string) =>
      isRequested(pluginName) ? 2 : isRecommended(pluginName) ? 1 : 0;
    const missingRequested = () =>
      requested.filter(
        (pluginName) =>
          !installedPlugins().some((item) => item.name === pluginName) &&
          !composioVisible().some((item) => item.name === pluginName),
      );
    const missingIntegrations = () => {
      const missingReqLower = new Set(
        missingRequested().map((item) => item.toLowerCase()),
      );
      return integrations.filter(
        (slug) =>
          !missingReqLower.has(slug.toLowerCase()) &&
          !installedPlugins().some((item) =>
            pluginMatchesIntegration(item.name, slug),
          ) &&
          !composioVisible().some((item) =>
            pluginMatchesIntegration(item.name, slug),
          ),
      );
    };
    const sortedInstalled = () =>
      [...installedPlugins()].sort((a, b) => rankOf(b.name) - rankOf(a.name));
    const sortedComposio = () =>
      [...composioVisible()].sort((a, b) => rankOf(b.name) - rankOf(a.name));
    const showSection = () =>
      totalAvailable() > 0 ||
      integrations.length > 0 ||
      requested.length > 0 ||
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
          <If when={missingRequested().length}>
            <WarningLine
              text={localizedText(
                `Not installed: ${missingRequested().join(", ")}`,
                `未安装插件：${missingRequested().join("、")}`,
              )}
            />
          </If>
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
                  const badge = () =>
                    entry.pluginName === item().name
                      ? localizedText("Parent plugin", "所属插件")
                      : isRequested(item().name)
                        ? localizedText("From config", "配置指定")
                        : isRecommended(item().name)
                          ? localizedText("Recommended", "推荐")
                          : "";
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
                                  (existing) => existing !== item().name,
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
                            <If when={badge()}>
                              <Label variant="caption" tone="muted">
                                {badge()}
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
                  const badge = () =>
                    isRequested(item().name)
                      ? localizedText("From config", "配置指定")
                      : isRecommended(item().name)
                        ? localizedText("Recommended", "推荐")
                        : "";
                  return (
                    <CheckControl
                      label={item().name}
                      checked={checked()}
                      disabled={!usable() && !checked()}
                      onChange={(enabled) =>
                        selectedPlugins.update((current) =>
                          enabled
                            ? [...new Set([...current, item().name])]
                            : current.filter(
                                (existing) => existing !== item().name,
                              ),
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
                          <If when={badge()}>
                            <Label variant="caption" tone="muted">
                              {badge()}
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

  function detailBadge(entry: GalleryEntry): string | undefined {
    if (entry.kind === "plugin" && entry.pluginName) return entry.pluginName;
    if (entry.kind === "local" && entry.draft)
      return sourceKindLabel(entry.draft.sourceKind);
    return undefined;
  }

  function detailSubtitle(entry: GalleryEntry): string {
    const template = entry.template;
    if (entry.kind === "plugin" && entry.pluginName) {
      return entry.draft?.filename
        ? `${localizedText("From plugin", "来自插件")} ${entry.pluginName} · ${entry.draft.filename}`
        : `${localizedText("From plugin", "来自插件")} ${entry.pluginName}`;
    }
    if (entry.kind === "local" && entry.draft) {
      return entry.draft.filename
        ? `${categoryName(template.category)} · ${entry.draft.filename}`
        : categoryName(template.category);
    }
    return template.note
      ? `${categoryName(template.category)} · ${template.note}`
      : categoryName(template.category);
  }

  function footerAttribution(entry: GalleryEntry): string {
    if (entry.kind === "plugin" && entry.pluginName) {
      return localizedText(
        `Bundled with plugin ${entry.pluginName}`,
        `随插件 ${entry.pluginName} 提供`,
      );
    }
    if (entry.kind === "local" && entry.draft) {
      return entry.draft.filename
        ? localizedText(
            `Local file · ${entry.draft.filename}`,
            `本地文件 · ${entry.draft.filename}`,
          )
        : localizedText(
            `Imported locally · ${sourceKindLabel(entry.draft.sourceKind)}`,
            `本地导入 · ${sourceKindLabel(entry.draft.sourceKind)}`,
          );
    }
    return localizedText(
      `From ${templateSource.repo} · ${templateSource.license}`,
      `来自 ${templateSource.repo} · ${templateSource.license}`,
    );
  }

  function detail(entry: GalleryEntry) {
    const template = entry.template;
    const placeholders = usesTemplatePlaceholders(entry)
      ? placeholdersOf(template.instructions)
      : [];
    const badge = detailBadge(entry);
    return (
      <SmoothScroll
        style={grow}
        contentStyle={{ padding: space[16], gap: space[12] }}
      >
        <View style={{ ...row, gap: space[12] }}>
          <AgentFace id={template.id} size={avatar.xl} />
          <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
            <View style={{ ...row, flexWrap: "wrap", gap: space[8] }}>
              <Label variant="subtitle" weight={weight.strong}>
                {template.name}
              </Label>
              <If when={badge}>
                <View
                  style={{
                    paddingHorizontal: space[8],
                    paddingVertical: space[2],
                    borderWidth: 1,
                    borderColor: c().border,
                    backgroundColor: c().surface,
                  }}
                >
                  <Label variant="caption" tone="muted">
                    {badge}
                  </Label>
                </View>
              </If>
            </View>
            <Label variant="small" tone="muted">
              {detailSubtitle(entry)}
            </Label>
          </View>
        </View>
        <If when={template.summary}>
          <Label variant="small">{template.summary}</Label>
        </If>
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
                <Markdown dense value={renderedInstructions(entry)} />
              </View>
            }
          >
            <Field
              label={localizedText("Instructions it gets", "它会拿到的指令")}
              multiline
              maxLength={agentInstructionsLimit}
              value={renderedInstructions(entry)}
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
          <If when={Boolean(entry.draft?.persona || persona())}>
            <Label variant="small" weight={weight.strong}>
              {localizedText("Persona", "人设")}
            </Label>
            <Field
              label={localizedText("Persona", "人设")}
              value={persona()}
              onChange={(value) => persona.set(value)}
              style={fieldStyle()}
            />
          </If>
          <If when={machines().length > 1 || Boolean(machineId())}>
            <Label variant="small" weight={weight.strong}>
              {uiText("runsOn")}
            </Label>
            <ActionMenu
              label={uiText("runsOn")}
              value={
                machines().find((item) => item.id === machineId())?.name ??
                machineId() ??
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
                      (item) => `${runtime()}:${item.id}` === model(),
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
                    key={(item) => item.id}
                  >
                    {(item) => (
                      <ActionItem
                        label={item().name}
                        checked={`${runtime()}:${item().id}` === model()}
                        onSelect={() => model.set(`${runtime()}:${item().id}`)}
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
          <If when={Boolean(entry.draft?.thinkingLevel || thinkingLevel())}>
            <Label variant="small" weight={weight.strong}>
              {localizedText("Thinking level", "思考深度")}
            </Label>
            <ActionMenu
              label={localizedText("Thinking level", "思考深度")}
              value={thinkingLevel() ?? localizedText("Default", "默认")}
              triggerStyle={fieldStyle()}
            >
              <ActionItem
                label={localizedText("Default", "默认")}
                checked={!thinkingLevel()}
                onSelect={() => thinkingLevel.set(null)}
              />
              <Each of={THINKING_LEVELS}>
                {(level) => (
                  <ActionItem
                    label={level()}
                    checked={thinkingLevel() === level()}
                    onSelect={() => thinkingLevel.set(level())}
                  />
                )}
              </Each>
            </ActionMenu>
          </If>
          {pluginsSection(entry)}
          <If when={error()}>
            <Label variant="small" tone="red">
              {error()}
            </Label>
          </If>
          <View style={{ ...row, gap: space[8] }}>
            <Label variant="caption" tone="muted" style={{ flex: 1 }}>
              {footerAttribution(entry)}
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
              onPress={() => void create(entry)}
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
        <Each
          of={chosen() ? [chosen()!] : []}
          key={(entry) => entry.template.id}
        >
          {(entry) => detail(entry())}
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
              {chosen()?.template.name ??
                localizedText("Agent templates", "智能体模版")}
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
      <If when={pasteOpen()}>
        <Modal
          title={localizedText("Paste bot config", "粘贴智能体配置")}
          phone={props.phone}
          width={dialogWidth.md}
          modalFocus
          onClose={closePaste}
        >
          <View style={{ padding: space[16], gap: space[12] }}>
            <Label variant="caption" tone="muted">
              {localizedText(
                "Paste Markdown, YAML, JSON, or a role card.",
                "粘贴 Markdown、YAML、JSON 或角色卡内容。",
              )}
            </Label>
            <View style={{ gap: space[4] }}>
              <Label variant="small" weight={weight.strong}>
                {localizedText("Filename (optional)", "文件名（可选）")}
              </Label>
              <Field
                label={localizedText("Filename (optional)", "文件名（可选）")}
                placeholder="reviewer.md / bot.yaml / bot.json"
                value={pasteFilename()}
                onChange={(value) => pasteFilename.set(value)}
                style={fieldStyle()}
              />
            </View>
            <View style={{ gap: space[4] }}>
              <Label variant="small" weight={weight.strong}>
                {localizedText("Bot definition", "智能体定义")}
              </Label>
              <Field
                label={localizedText("Bot definition", "智能体定义")}
                placeholder={localizedText(
                  "Paste bot file contents here…",
                  "在此粘贴智能体文件内容…",
                )}
                multiline
                value={pasteText()}
                onChange={(value) => {
                  pasteText.set(value);
                  if (pasteError()) pasteError.set("");
                }}
                style={{
                  height: pasteInputHeight,
                  ...textStyle(type("small"), "prose"),
                  padding: space[12],
                  borderColor: c().border,
                }}
              />
            </View>
            <If when={pasteError()}>
              <View testID="paste-error">
                <Label variant="small" tone="red">
                  {pasteError()}
                </Label>
              </View>
            </If>
            <View style={{ ...row, justifyContent: "flex-end", gap: space[8] }}>
              <Button
                label={localizedText("Cancel", "取消")}
                tone="ghost"
                size={props.phone ? control.touch : control.md}
                style={{ paddingHorizontal: space[12] }}
                onPress={closePaste}
              />
              <Button
                label={localizedText("Parse & load", "解析并加载")}
                tone="primary"
                size={props.phone ? control.touch : control.md}
                style={{ paddingHorizontal: space[12] }}
                onPress={submitPaste}
              />
            </View>
          </View>
        </Modal>
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
