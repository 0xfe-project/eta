import type {
  AgentFields,
  AgentResults,
  AgentRuntime,
  AgentRuntimeInfo,
  MachineView,
  PluginView,
  ThinkingLevel,
} from "@eta/client-contracts";
import type { JSX } from "nsh";
import { AGENT_RUNTIMES } from "@eta/client-contracts";
import { cleanup, effect, Scroll, signal, View } from "nsh";
import { Checkbox } from "nsh/base";
import { follow, useHost } from "./host";
import { formatLocale, uiText } from "./locale";
import { ModelSelect, useModels } from "./models";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  Field,
  grow,
  Icon,
  Label,
  Modal,
  row,
} from "./ui";

const agentNameLimit = 100;
const agentInstructionsLimit = 10_000;
const thinkingOptions: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];
const editorTabs = ["general", "instructions", "plugins"] as const;
type AgentTab = (typeof editorTabs)[number];

function editorCopy(english: string, chinese: string) {
  return formatLocale() === "zh-CN" ? chinese : english;
}

function EditorRow(props: {
  label: string;
  hint?: JSX.Element;
  stack: boolean;
  phone?: boolean;
  children?: JSX.Element;
}) {
  const c = colors();
  return (
    <View
      style={{
        ...(props.stack ? { gap: props.phone ? 8 : 4 } : row),
        minHeight: props.stack ? undefined : 43,
        paddingHorizontal: props.stack && !props.phone ? 0 : 16,
        paddingVertical: props.stack && !props.phone ? 0 : 8,
        borderBottomWidth: props.stack && !props.phone ? 0 : 1,
        borderColor: c().border,
        columnGap: 12,
      }}
    >
      <View style={props.stack ? undefined : { flex: 1, minWidth: 0, gap: 3 }}>
        <Label size={props.phone ? 14 : props.stack ? 11 : 13}>
          {props.label}
        </Label>
        <If when={!props.stack}>{props.hint}</If>
      </View>
      <View style={{ width: props.stack ? "100%" : 162, flexShrink: 0 }}>
        {props.children}
      </View>
      <If when={props.stack}>{props.hint}</If>
    </View>
  );
}

export function AgentEditor(props: {
  id?: string;
  phone: boolean;
  tablet?: boolean;
  onClose: () => void;
  onModelServices: () => void;
}) {
  const host = useHost();
  const c = colors();
  const saved = props.id ? host.agent(props.id) : undefined;
  const name = signal(saved?.name ?? "");
  const instructions = signal(saved?.instructions ?? "");
  const model = signal(saved?.model ?? "");
  const runtime = signal<AgentRuntime>(saved?.runtime ?? "eta");
  const persona = signal(saved?.persona ?? "");
  const plugins = signal(saved?.plugins ?? []);
  const machineId = signal<string | null>(saved?.machineId ?? null);
  const thinking = signal<ThinkingLevel | null>(saved?.thinkingLevel ?? null);
  const tab = signal<AgentTab>("general");
  const step = signal<1 | 2>(1);
  const busy = signal(false);
  const deleting = signal(false);
  const customPersona = signal(false);
  const installed = signal<AgentRuntimeInfo[] | undefined>(undefined);
  const models = useModels();
  const creating = !props.id;
  const phoneEditor = () => props.phone && !creating;
  const stacked = () => creating || props.phone;
  const controlHeight = () => (phoneEditor() ? 32 : 28);
  const title = () => saved?.name ?? editorCopy("New agent", "新建智能体");
  const canDelete = () =>
    !!saved && saved.systemRole !== "captain" && host.can("agents.delete");
  const canSave = () => {
    if (busy() || !name().trim()) return false;
    return (
      runtime() !== "eta" ||
      Boolean(model().trim()) ||
      Boolean(saved?.runtime === "eta" && !saved.model)
    );
  };
  follow(() => "machines");
  follow(() => "plugins");
  follow(() => "personas");
  const machines = () =>
    host
      .list<MachineView>("machines")
      .filter(
        (item) =>
          item.id === machineId() ||
          item.status === "online" ||
          item.status === "offline",
      );
  const showRunsOn = () =>
    creating ||
    runtime() === "eta" ||
    Boolean(machineId()) ||
    machines().length > 1;
  const activePlugins = () => host.list<PluginView>("plugins");
  const cards = () =>
    host.list<{ id: string; name: string; description: string }>(
      "personas",
      "cards",
    );
  const runtimeList = () => [
    ...new Set<AgentRuntime>([
      ...AGENT_RUNTIMES,
      ...(installed()?.map((item) => item.id) ?? []),
      runtime(),
    ]),
  ];
  const external = () => installed()?.find((item) => item.id === runtime());
  const runtimeLabel = (id: AgentRuntime) =>
    id === "eta"
      ? uiText("etaBuiltIn")
      : (installed()?.find((item) => item.id === id)?.label ??
        (
          {
            claude: "Claude Code",
            codex: "Codex",
            opencode: "OpenCode",
            pi: "Pi",
          } as Record<string, string>
        )[id] ??
        id);
  const noModels = () => runtime() === "eta" && models().length === 0;
  const missingModel = () =>
    Boolean(model().trim()) &&
    (runtime() === "eta"
      ? !models().some((entry) => entry.id === model())
      : external()?.status === "missing" ||
        Boolean(
          external()?.models.length &&
            !external()?.models.some(
              (entry) => `${runtime()}:${entry.id}` === model(),
            ),
        ));
  const personaDefault = () =>
    editorCopy("Project default", "使用项目默认人设");
  const instructionsHelp = () =>
    editorCopy(
      "Added to the agent's context. Changes take effect when idle without interrupting active replies.",
      "添加到智能体的上下文。修改会在它空闲时生效，正在进行的回复不受影响。",
    );

  effect(() => {
    const machine = machineId();
    if (!host.can("agents.runtimes")) return;
    let current = true;
    installed.set(undefined);
    cleanup(() => {
      current = false;
    });
    void host
      .call<AgentResults["runtimes"]>(
        "agents",
        "runtimes",
        machine ? { machineId: machine } : {},
      )
      .then((result) => {
        if (current) installed.set(result.runtimes);
      })
      .catch(() => {});
  });

  function close() {
    if (!busy()) props.onClose();
  }
  function chooseRuntime(next: AgentRuntime) {
    if (runtime() === next) return;
    runtime.set(next);
    model.set("");
    thinking.set(null);
  }
  function chooseModel(next: string) {
    if (model() === next) return;
    model.set(next);
    thinking.set(null);
  }
  function runtimeModel() {
    const value = model().trim();
    if (!value) return null;
    return runtime() !== "eta" && !value.includes(":") && value !== saved?.model
      ? `${runtime()}:${value}`
      : value;
  }

  async function save() {
    if (!canSave()) return;
    const fields: AgentFields = {
      name: name().trim(),
      instructions: instructions(),
      model: runtimeModel(),
      runtime: runtime(),
      plugins: plugins(),
      persona: persona(),
      machineId: machineId(),
      thinkingLevel: thinking(),
    };
    const patch = saved
      ? {
          ...(fields.name !== saved.name && { name: fields.name }),
          ...(fields.instructions !== saved.instructions && {
            instructions: fields.instructions,
          }),
          ...(fields.model !== saved.model && { model: fields.model }),
          ...(fields.runtime !== saved.runtime && { runtime: fields.runtime }),
          ...(fields.persona !== saved.persona && { persona: fields.persona }),
          ...(fields.machineId !== saved.machineId && {
            machineId: fields.machineId,
          }),
          ...(fields.thinkingLevel !== saved.thinkingLevel && {
            thinkingLevel: fields.thinkingLevel,
          }),
          ...(JSON.stringify(fields.plugins) !==
            JSON.stringify(saved.plugins) && { plugins: fields.plugins }),
        }
      : fields;
    busy.set(true);
    const result = await host.action(() =>
      props.id
        ? host.call<AgentResults["update"]>("agents", "update", {
            agentId: props.id,
            ...patch,
          })
        : host.call<AgentResults["create"]>("agents", "create", fields),
    );
    busy.set(false);
    if (result) close();
  }
  async function remove() {
    if (!canDelete() || !props.id || busy()) return;
    busy.set(true);
    const result = await host.action(() =>
      host.call<AgentResults["delete"]>("agents", "delete", {
        agentId: props.id!,
      }),
    );
    busy.set(false);
    if (result) close();
  }

  function machineField() {
    if (phoneEditor()) {
      const items = () => [
        {
          id: null,
          title: editorCopy("Follow the project", "随项目选择"),
          detail: editorCopy(
            "Runs on the machine the project is on",
            "在项目所在的机器上运行",
          ),
          online: false,
        },
        ...machines().map((item) => ({
          id: item.id,
          title:
            item.kind === "primary"
              ? editorCopy(`${item.name} (primary)`, `${item.name}（主机）`)
              : item.name,
          detail:
            item.status === "online"
              ? editorCopy("Online", "在线")
              : editorCopy("Offline", "离线"),
          online: item.status === "online",
        })),
      ];
      return (
        <View role="radiogroup" accessibilityLabel={uiText("runsOn")}>
          <View
            style={{
              paddingHorizontal: 16,
              height: 44,
              justifyContent: "center",
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <Label weight={600}>{uiText("runsOn")}</Label>
          </View>
          <Each of={items()} key={(item) => item.id ?? "project"}>
            {(item) => {
              const picked = () => machineId() === item().id;
              return (
                <Checkbox
                  role="radio"
                  accessibilityLabel={item().title}
                  checked={picked()}
                  onChange={() => machineId.set(item().id)}
                  indicatorStyle={{
                    width: 16,
                    height: 16,
                    borderWidth: 1,
                    borderColor: c().strong,
                    backgroundColor: picked() ? c().button : c().canvas,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                  indicator={
                    <If when={picked()}>
                      <Icon name="check" size={10} tone="buttonInk" />
                    </If>
                  }
                  style={{
                    ...row,
                    minHeight: 55,
                    paddingHorizontal: 22,
                    gap: 16,
                    borderBottomWidth: 1,
                    borderColor: c().border,
                    cursor: "pointer",
                  }}
                >
                  <View style={{ ...grow, gap: 2 }}>
                    <Label weight={500} lines={1}>
                      {item().title}
                    </Label>
                    <View style={{ ...row, gap: 5 }}>
                      <If when={item().id}>
                        <View
                          style={{
                            width: 6,
                            height: 6,
                            backgroundColor: item().online
                              ? c().green
                              : c().strong,
                          }}
                        />
                      </If>
                      <Label size={12} tone="muted">
                        {item().detail}
                      </Label>
                    </View>
                  </View>
                </Checkbox>
              );
            }}
          </Each>
        </View>
      );
    }
    return (
      <EditorRow
        label={uiText("runsOn")}
        stack={stacked()}
        hint={
          !creating ? (
            <Label size={10} line={14} tone="muted">
              {editorCopy(
                "Uses the machine for the project when no machine is chosen here.",
                "未设置时，使用项目所在的机器。",
              )}
            </Label>
          ) : undefined
        }
      >
        <ActionMenu
          label={uiText("runsOn")}
          value={
            machines().find((item) => item.id === machineId())?.name ??
            (machineId()
              ? editorCopy("Unavailable machine", "机器不可用")
              : uiText("followProject"))
          }
          triggerStyle={{ height: controlHeight() }}
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
      </EditorRow>
    );
  }

  function modelWarning() {
    return (
      <If when={missingModel() || noModels()}>
        <View style={{ alignItems: "flex-start", gap: 2 }}>
          <Label size={10} line={13} tone={missingModel() ? "amber" : "muted"}>
            {missingModel()
              ? editorCopy(
                  "This model is no longer available. Choose another one.",
                  "该模型已不可用，请选择其他模型。",
                )
              : editorCopy("No models available.", "暂无可用模型。")}
          </Label>
          <Button
            label={editorCopy("Go to model services", "前往模型服务")}
            tone="ghost"
            size={16}
            labelSize={10}
            style={{ paddingHorizontal: 0 }}
            onPress={props.onModelServices}
          />
        </View>
      </If>
    );
  }

  function general() {
    return (
      <View style={creating ? { padding: 14, gap: 12 } : undefined}>
        <EditorRow
          label={uiText("name")}
          stack={stacked()}
          phone={phoneEditor()}
        >
          <Field
            label={uiText("name")}
            value={name()}
            onChange={name.set}
            placeholder={
              creating
                ? editorCopy("e.g. Code review", "例如：代码审查")
                : undefined
            }
            maxLength={agentNameLimit}
            style={{ height: controlHeight(), fontSize: 12 }}
          />
        </EditorRow>
        <If when={showRunsOn()}>{machineField()}</If>
        <EditorRow
          label={uiText("runtime")}
          stack={stacked()}
          phone={phoneEditor()}
        >
          <ActionMenu
            label={uiText("runtime")}
            value={runtimeLabel(runtime())}
            triggerStyle={{ height: controlHeight() }}
          >
            <Each of={runtimeList()}>
              {(item) => (
                <ActionItem
                  label={runtimeLabel(item())}
                  checked={runtime() === item()}
                  onSelect={() => chooseRuntime(item())}
                />
              )}
            </Each>
          </ActionMenu>
        </EditorRow>
        <EditorRow
          label={uiText("model")}
          stack={stacked()}
          phone={phoneEditor()}
          hint={modelWarning()}
        >
          <If
            when={runtime() === "eta"}
            else={
              <If
                when={external()?.models.length}
                else={
                  <Field
                    label={uiText("model")}
                    placeholder={uiText("runtimeDefault")}
                    value={model()}
                    onChange={chooseModel}
                    style={{ height: controlHeight(), fontSize: 12 }}
                  />
                }
              >
                <ActionMenu
                  label={uiText("model")}
                  value={
                    external()?.models.find(
                      (entry) => `${runtime()}:${entry.id}` === model(),
                    )?.name ||
                    model() ||
                    uiText("runtimeDefault")
                  }
                  triggerStyle={{ height: controlHeight() }}
                >
                  <ActionItem
                    label={uiText("runtimeDefault")}
                    checked={!model()}
                    onSelect={() => chooseModel("")}
                  />
                  <Each of={external()?.models ?? []} key={(entry) => entry.id}>
                    {(entry) => (
                      <ActionItem
                        label={entry().name}
                        checked={`${runtime()}:${entry().id}` === model()}
                        onSelect={() =>
                          chooseModel(`${runtime()}:${entry().id}`)
                        }
                      />
                    )}
                  </Each>
                </ActionMenu>
              </If>
            }
          >
            <ModelSelect value={model()} onChange={chooseModel} />
          </If>
        </EditorRow>
        <EditorRow
          label={uiText("thinkingLevel")}
          stack={stacked()}
          phone={phoneEditor()}
        >
          <ActionMenu
            label={uiText("thinkingLevel")}
            value={thinking() ?? uiText("modelDefault")}
            triggerStyle={{ height: controlHeight() }}
          >
            <ActionItem
              label={uiText("modelDefault")}
              checked={!thinking()}
              onSelect={() => thinking.set(null)}
            />
            <Each of={thinkingOptions}>
              {(option) => (
                <ActionItem
                  label={option()}
                  checked={thinking() === option()}
                  onSelect={() => thinking.set(option())}
                />
              )}
            </Each>
          </ActionMenu>
        </EditorRow>
        <If when={!creating}>{personaField()}</If>
      </View>
    );
  }

  function personaField() {
    return (
      <EditorRow
        label={uiText("persona")}
        stack={stacked()}
        phone={phoneEditor()}
      >
        <If
          when={customPersona()}
          else={
            <ActionMenu
              label={uiText("persona")}
              value={
                cards().find((item) => item.id === persona())?.name ??
                (persona() || personaDefault())
              }
              triggerStyle={{ height: controlHeight() }}
            >
              <ActionItem
                label={personaDefault()}
                checked={!persona()}
                onSelect={() => persona.set("")}
              />
              <Each of={cards()} key={(entry) => entry.id}>
                {(entry) => (
                  <ActionItem
                    label={entry().name}
                    checked={persona() === entry().id}
                    onSelect={() => persona.set(entry().id)}
                  />
                )}
              </Each>
              <ActionItem
                label={editorCopy("Custom name…", "输入自定义名称…")}
                onSelect={() => customPersona.set(true)}
              />
            </ActionMenu>
          }
        >
          <Field
            label={uiText("persona")}
            placeholder={personaDefault()}
            value={persona()}
            onChange={persona.set}
            onSubmit={() => customPersona.set(false)}
            style={{ height: controlHeight(), fontSize: 12 }}
          />
        </If>
      </EditorRow>
    );
  }

  function instructionsFields() {
    return (
      <View style={{ padding: creating ? 14 : 16, gap: 12 }}>
        <View style={{ gap: 6 }}>
          <View style={{ ...row, justifyContent: "space-between" }}>
            <Label size={12} weight={creating ? 400 : 600}>
              {uiText("instructions")}
            </Label>
            <If when={!creating || instructions().length}>
              <Label
                size={10}
                tone="muted"
              >{`${instructions().length.toLocaleString(formatLocale())} / ${agentInstructionsLimit.toLocaleString(formatLocale())}`}</Label>
            </If>
          </View>
          <If when={!creating}>
            <Label size={11} line={15} tone="muted">
              {instructionsHelp()}
            </Label>
          </If>
          <Field
            label={uiText("instructions")}
            multiline
            maxLength={Math.max(
              agentInstructionsLimit,
              saved?.instructions.length ?? 0,
            )}
            style={{
              height: creating ? 200 : 246,
              fontSize: 12,
              lineHeight: 19,
              padding: 10,
            }}
            value={instructions()}
            onChange={instructions.set}
          />
          <If when={creating}>
            <Label size={10} line={15} tone="muted">
              {instructionsHelp()}
            </Label>
          </If>
        </View>
        <If when={creating}>{personaField()}</If>
      </View>
    );
  }

  function pluginFields() {
    return (
      <View>
        <View style={{ padding: 16, gap: 4 }}>
          <Label
            size={13}
            weight={600}
          >{`${uiText("plugins")}  ${activePlugins().length}`}</Label>
          <Label size={11} tone="muted">
            {editorCopy(
              "Pick the plugins this agent may use.",
              "选择这个智能体可以使用的插件。",
            )}
          </Label>
        </View>
        <Each of={activePlugins()} key={(item) => item.name}>
          {(item) => {
            const checked = () => plugins().includes(item().name);
            const ready = () => item().state === "ready";
            return (
              <Checkbox
                accessibilityLabel={item().name}
                checked={checked()}
                disabled={!ready() && !checked()}
                onChange={({ checked: enabled }) =>
                  plugins.update((list) =>
                    enabled
                      ? [...new Set([...list, item().name])]
                      : list.filter((entry) => entry !== item().name),
                  )
                }
                indicatorStyle={{
                  width: 15,
                  height: 15,
                  marginTop: 1,
                  flexShrink: 0,
                  borderWidth: 1,
                  borderColor: c().strong,
                  backgroundColor: checked() ? c().button : c().canvas,
                  alignItems: "center",
                  justifyContent: "center",
                }}
                indicator={
                  <If when={checked()}>
                    <Icon name="check" size={10} tone="buttonInk" />
                  </If>
                }
                style={{
                  ...row,
                  alignItems: "flex-start",
                  paddingHorizontal: 16,
                  paddingVertical: 9,
                  gap: 8,
                  minHeight: 45,
                  borderTopWidth: 1,
                  borderColor: c().border,
                  cursor: ready() || checked() ? "pointer" : "default",
                }}
              >
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Label size={12} weight={600}>
                    {item().name}
                  </Label>
                  <Label size={10} lines={1} tone="muted">
                    {editorCopy(
                      `${item().skills.length} skills · ${item().servers.length} MCP servers`,
                      `${item().skills.length} 项技能 · ${item().servers.length} 个 MCP 服务器`,
                    )}
                  </Label>
                  <If when={checked() && !ready()}>
                    <Label size={10} tone="amber">
                      {editorCopy(
                        "Its configuration no longer fits. Sessions skip it.",
                        "其配置已不适用，会话会跳过此插件。",
                      )}
                    </Label>
                  </If>
                </View>
                <Label size={10} tone={ready() ? "muted" : "amber"}>
                  {ready()
                    ? uiText("canBeEnabled")
                    : uiText("needsConfiguring")}
                </Label>
              </Checkbox>
            );
          }}
        </Each>
      </View>
    );
  }

  function deleteRow() {
    return (
      <If when={canDelete()}>
        <View
          style={{
            ...row,
            justifyContent: "space-between",
            minHeight: 42,
            paddingHorizontal: 16,
            borderBottomWidth: tab() === "general" ? 1 : 0,
            borderTopWidth: tab() === "general" ? 0 : 1,
            borderColor: c().border,
          }}
        >
          <Label size={13}>{editorCopy("Delete agent", "删除智能体")}</Label>
          <Button
            label={editorCopy("Delete", "删除")}
            icon="archive"
            disabled={busy()}
            onPress={() => deleting.set(true)}
          />
        </View>
      </If>
    );
  }

  const tabLabel = (value: AgentTab) =>
    value === "general" ? editorCopy("General", "常规") : uiText(value);
  return (
    <Modal
      title={title()}
      phone={props.phone}
      phonePage={phoneEditor()}
      width={creating ? 385 : 640}
      height={
        props.phone
          ? phoneEditor()
            ? "100%"
            : "90%"
          : creating
            ? props.tablet
              ? 600
              : 480
            : 520
      }
      modalFocus
      blurBackdrop={creating}
      hideHeader
      dismissible={!busy()}
      onClose={close}
    >
      <View
        style={{
          ...row,
          minHeight: phoneEditor() ? 45 : creating ? 44 : 40,
          gap: phoneEditor() ? 12 : 7,
          paddingHorizontal: phoneEditor() ? 16 : 11,
          borderBottomWidth: 1,
          borderColor: c().border,
        }}
      >
        <If when={phoneEditor()}>
          <Button
            label={uiText("back")}
            icon="back"
            iconOnly
            tone="ghost"
            disabled={busy()}
            onPress={close}
          />
        </If>
        <If when={!creating}>
          <View
            style={{
              width: 22,
              height: 22,
              alignItems: "center",
              justifyContent: "center",
              borderWidth: 1,
              borderColor: c().border,
            }}
          >
            <Label size={11} weight={600}>
              {title().slice(0, 1).toUpperCase()}
            </Label>
          </View>
        </If>
        <Label size={15} style={{ flex: 1 }} weight={500}>
          {title()}
        </Label>
        <If when={!phoneEditor()}>
          <Button
            label={uiText("close")}
            icon="close"
            iconOnly
            tone="ghost"
            disabled={busy()}
            onPress={close}
          />
        </If>
      </View>
      <If
        when={creating}
        else={
          <View
            style={{ ...grow, flexDirection: props.phone ? "column" : "row" }}
          >
            <View
              style={{
                flexDirection: props.phone ? "row" : "column",
                padding: props.phone ? 0 : 5,
                gap: props.phone ? 0 : 1,
                width: props.phone ? undefined : 158,
                flexShrink: 0,
                borderRightWidth: props.phone ? 0 : 1,
                borderBottomWidth: props.phone ? 1 : 0,
                borderColor: c().border,
              }}
            >
              <Each of={editorTabs}>
                {(entry) => (
                  <Button
                    label={tabLabel(entry())}
                    selected={tab() === entry()}
                    tone="ghost"
                    size={props.phone ? 40 : 31}
                    style={
                      props.phone
                        ? {
                            flex: 1,
                            borderBottomWidth: 2,
                            borderColor:
                              tab() === entry() ? c().ink : c().border,
                            backgroundColor: c().canvas,
                          }
                        : { justifyContent: "flex-start" }
                    }
                    onPress={() => tab.set(entry())}
                  />
                )}
              </Each>
            </View>
            <View style={grow}>
              <Scroll style={grow} scrollbar={false}>
                <If when={tab() === "general"}>
                  {general()}
                  {deleteRow()}
                </If>
                <If when={tab() === "instructions"}>{instructionsFields()}</If>
                <If when={tab() === "plugins"}>{pluginFields()}</If>
              </Scroll>
              <If when={tab() !== "general"}>{deleteRow()}</If>
            </View>
          </View>
        }
      >
        <View
          style={{
            ...row,
            minHeight: 40,
            gap: 10,
            paddingHorizontal: 14,
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <Label size={10} tone="muted">{`${step()}/2`}</Label>
          <Label size={12} weight={600} style={{ flex: 1 }}>
            {step() === 1
              ? editorCopy("Name and model", "名称与模型")
              : uiText("instructions")}
          </Label>
          <Label size={11} tone="muted">
            {step() === 1
              ? editorCopy("Next: Instructions", "下一步：指令")
              : uiText("lastStep")}
          </Label>
          <View style={{ ...row, gap: 4 }}>
            <View
              style={{
                width: 7,
                height: 7,
                backgroundColor: step() === 1 ? c().ink : c().faint,
              }}
            />
            <View
              style={{
                width: 7,
                height: 7,
                borderWidth: 1,
                borderColor: c().border,
                backgroundColor: step() === 2 ? c().ink : c().canvas,
              }}
            />
          </View>
        </View>
        <Scroll style={grow} scrollbar={false}>
          <If when={step() === 1} else={instructionsFields()}>
            {general()}
          </If>
        </Scroll>
      </If>
      <View
        style={{
          ...row,
          paddingHorizontal: phoneEditor() ? 16 : 14,
          minHeight: phoneEditor() ? 49 : creating ? 50 : 45,
          justifyContent: "flex-end",
          gap: 8,
          borderTopWidth: 1,
          borderColor: c().border,
        }}
      >
        <Button
          label={uiText("cancel")}
          onPress={close}
          disabled={busy()}
          size={phoneEditor() ? 32 : undefined}
          style={phoneEditor() ? { minWidth: 70 } : undefined}
          tone={creating ? "ghost" : undefined}
        />
        <If when={creating && step() === 2}>
          <View style={{ flex: 1 }} />
          <Button
            label={editorCopy("Previous", "上一步")}
            onPress={() => step.set(1)}
            disabled={busy()}
          />
        </If>
        <If
          when={creating && step() === 1}
          else={
            <Button
              label={creating ? editorCopy("Create", "创建") : uiText("save")}
              tone="primary"
              disabled={!canSave()}
              onPress={() => void save()}
            />
          }
        >
          <Button
            label={uiText("next")}
            tone="primary"
            disabled={!name().trim()}
            onPress={() => step.set(2)}
          />
        </If>
      </View>
      <If when={deleting()}>
        <Modal
          title={editorCopy("Delete agent?", "删除智能体？")}
          phone={props.phone}
          width={392}
          modalFocus
          overPhoneNavigation
          onClose={() => {
            if (!busy()) deleting.set(false);
          }}
        >
          <View style={{ padding: 16, gap: 14 }}>
            <Label>
              {editorCopy(
                `Delete ${title()}? Its direct chat will be archived. Its files stay on the host.`,
                `删除${title()}？其私聊将归档，文件会留在主机上。`,
              )}
            </Label>
            <View style={{ ...row, justifyContent: "flex-end", gap: 8 }}>
              <Button
                label={uiText("cancel")}
                disabled={busy()}
                onPress={() => deleting.set(false)}
              />
              <Button
                label={editorCopy("Delete", "删除")}
                disabled={busy()}
                tone="danger"
                onPress={() => void remove()}
              />
            </View>
          </View>
        </Modal>
      </If>
    </Modal>
  );
}
