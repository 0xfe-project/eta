import type { AgentResults, AgentView } from "@eta/client-contracts";
import type { ScrollRef } from "nsh";
import type { AgentTemplate } from "./template";
import { computed, signal, View } from "nsh";
import {
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
import { avatar, control, icon, space } from "../../components/tokens";
import { localizedText } from "../../i18n";
import { useHost } from "../../services/host";
import { ModelSelect, useModels } from "../../ui";
import { templates, templateSource } from "./catalog";
import {
  fillTemplate,
  findTemplates,
  placeholdersOf,
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

export interface TemplateGalleryProps {
  phone: boolean;
  /** The template to open on, instead of the first in the list. */
  initialId?: string;
  onClose: () => void;
  /** The agent made from a template. */
  onCreated: (agent: AgentView) => void;
  onModelServices: () => void;
}

const categoryName = (category: string) =>
  localizedText(category, templateCategories[category] ?? category);

/**
 * Agents to start from: the role cards of the bundled catalog, searched and filtered by category.
 * One opens to what it owns, what it leaves alone, what it asks first and the instructions it
 * gives, which the reader reads before anything is made; Import makes the agent with those
 * instructions, its name in place of `{NAME}` and the other placeholders as filled in.
 */
export function TemplateGallery(props: TemplateGalleryProps) {
  const c = colors();
  const host = useHost();
  const type = textFaces();
  const models = useModels();
  const query = signal("");
  const category = signal<string | undefined>(undefined);
  const known = templates.some((template) => template.id === props.initialId);
  const chosenId = signal<string | undefined>(
    known ? props.initialId : undefined,
  );
  const name = signal("");
  const values = signal<Record<string, string>>({});
  const model = signal("");
  const busy = signal(false);
  const error = signal("");
  const shown = computed(() => findTemplates(templates, query(), category()));
  const chosen = computed(() => {
    const id = chosenId();
    const list = shown();
    // Off phones one is always open: the chosen one, else the first that matches.
    return (
      templates.find((template) => template.id === id) ??
      (props.phone ? undefined : list[0])
    );
  });
  const chosenModel = () => model() || models()[0]?.id || "";

  function choose(template: AgentTemplate) {
    chosenId.set(template.id);
    name.set("");
    values.set({});
    error.set("");
  }
  async function create(template: AgentTemplate) {
    const agentName = name().trim() || template.name;
    if (busy() || !chosenModel()) return;
    busy.set(true);
    error.set("");
    try {
      const { agent } = await host.call<AgentResults["create"]>(
        "agents",
        "create",
        {
          name: agentName,
          instructions: fillTemplate(
            template.instructions,
            agentName,
            values(),
          ),
          model: chosenModel(),
        },
      );
      // The face it showed here; the agent is made either way.
      await host
        .call("agents", "update", {
          agentId: agent.id,
          avatarSeed: template.id,
        })
        .catch(() => {});
      props.onCreated(agent);
    } catch (cause) {
      error.set(cause instanceof Error ? cause.message : String(cause));
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

  let listScroll: ScrollRef | undefined;
  /** The template a link opened on, brought into the list's view (rows are `rowHeight` tall). */
  function revealInitial() {
    const index = shown().findIndex(
      (template) => template.id === props.initialId,
    );
    if (index > 2)
      listScroll?.scrollTo({ y: (index - 2) * rowHeight, animated: false });
  }

  function list() {
    return (
      <SmoothScroll
        ref={(node) => {
          listScroll = node;
          revealInitial();
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

  function points(title: string, items: string[]) {
    return (
      <If when={items.length}>
        <View style={{ gap: space[4] }}>
          <Label variant="small" weight={600}>
            {title}
          </Label>
          <Markdown dense value={items.map((item) => `- ${item}`).join("\n")} />
        </View>
      </If>
    );
  }

  function detail(template: AgentTemplate) {
    const agentName = () => name().trim() || template.name;
    return (
      <SmoothScroll
        style={grow}
        contentStyle={{ padding: space[16], gap: space[12] }}
      >
        <View style={{ ...row, gap: space[12] }}>
          <AgentFace id={template.id} size={avatar.xl} />
          <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
            <Label variant="subtitle" weight={600}>
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
        {points(localizedText("Owns", "负责"), template.owns)}
        {points(localizedText("Leaves alone", "不负责"), template.doesNotOwn)}
        {points(
          localizedText("Asks you first", "需要你批准"),
          template.needsApproval,
        )}
        <View style={{ gap: space[4] }}>
          <Label variant="small" weight={600}>
            {localizedText("Instructions it gets", "它会拿到的指令")}
          </Label>
          <View
            testID="template-instructions"
            style={{
              padding: space[12],
              borderWidth: 1,
              borderColor: c().border,
              backgroundColor: c().surface,
            }}
          >
            <Markdown
              dense
              value={fillTemplate(template.instructions, agentName(), values())}
            />
          </View>
        </View>
        <View
          style={{
            gap: space[8],
            paddingTop: space[12],
            borderTopWidth: 1,
            borderColor: c().border,
          }}
        >
          <Label variant="small" weight={600}>
            {localizedText("Name", "名字")}
          </Label>
          <Field
            label={localizedText("Name", "名字")}
            placeholder={template.name}
            value={name()}
            onChange={(value) => name.set(value)}
            style={fieldStyle()}
          />
          <If when={placeholdersOf(template.instructions).length}>
            <Label variant="small" tone="muted">
              {localizedText(
                "Fill in what you know now; the rest stays in the instructions to change later.",
                "能填的先填，没填的会原样留在指令里，之后可以再改。",
              )}
            </Label>
            <Each of={placeholdersOf(template.instructions)} key={(key) => key}>
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
          <Label variant="small" weight={600}>
            {localizedText("Model", "模型")}
          </Label>
          <If
            when={models().length}
            else={
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
            }
          >
            <ModelSelect value={chosenModel()} onChange={model.set} />
          </If>
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
              disabled={busy() || !chosenModel()}
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
      <Each of={chosen() ? [chosen()!] : []} key={(template) => template.id}>
        {(template) => detail(template())}
      </Each>
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
            <Label weight={600} lines={1} style={{ flex: 1 }}>
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
    </Modal>
  );
}
