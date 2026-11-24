import type {
  MachineView,
  SkillList,
  SkillSummary,
  SkillTarget,
} from "@eta/client-contracts";
import type { JSX } from "nsh";
import type { Layout } from "../../../components";
import type { SkillCall } from "./detail";
import { cleanup, computed, effect, signal, untracked, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  Empty,
  Field,
  grow,
  Header,
  Icon,
  Label,
  ListSkeleton,
  row,
  sizes,
  SmoothScroll,
  textFaces,
} from "../../../components";
import {
  control,
  icon,
  opacity,
  space,
  weight,
} from "../../../components/tokens";
import { uiText } from "../../../i18n";
import { follow, useHost } from "../../../services/host";
import { SkillDetail } from "./detail";
import { SkillSelect } from "./select";

/** The desktop's project select and search field. */
const projectSelectWidth = 200;
const searchWidth = 232;
/** A skill: a row of the tablet list, a card of the desktop grid. */
const tabletRowHeight = 60;
const cardWidth = 268;

export function Skills(props: {
  layout: Layout;
  tabs: () => JSX.Element;
  onBack?: () => void;
}) {
  const host = useHost();
  const c = colors();
  const type = textFaces();
  const device = signal("");
  const scope = signal<"personal" | "project">("personal");
  const projectId = signal("");
  const query = signal("");
  const entries = signal<SkillSummary[]>([]);
  const selectedPath = signal("");
  const loading = signal(false);
  const failure = signal("");
  const retry = signal(0);
  const resolved = signal<SkillTarget>();
  const missing = signal(false);
  follow(() => "machines");

  const phone = () => props.layout === "phone";
  const tablet = () => props.layout === "tablet";
  const available = () => host.can("skills.list");
  const devices = computed(() =>
    host
      .list<MachineView>("machines")
      .filter(
        (item) =>
          (item.kind === "primary" || item.kind === "daemon") &&
          item.status !== "revoked",
      )
      .sort(
        (a, b) => Number(b.kind === "primary") - Number(a.kind === "primary"),
      ),
  );
  const machine = () =>
    devices().find((item) => item.id === device()) ?? devices()[0];
  const projects = () =>
    host
      .projects()
      .filter(
        (item) =>
          item.kind === "project" &&
          !item.archived &&
          (item.machineId === machine()?.id ||
            (!item.machineId && machine()?.kind === "primary")),
      );
  const project = () =>
    projects().find((item) => item.id === projectId()) ?? projects()[0];
  const machineLabel = () =>
    machine()
      ? [
          machine()!.name,
          machine()!.kind === "primary" ? uiText("skillPrimaryDevice") : "",
        ]
          .filter(Boolean)
          .join(" ")
      : uiText("skillHost");
  const scopeLabel = () =>
    scope() === "project"
      ? (project()?.name ?? uiText("project2"))
      : uiText("personal");
  const selected = () => entries().find((item) => item.path === selectedPath());
  const showing = () => selected() && resolved();
  const location = computed(() => {
    const current = machine();
    const currentProject = scope() === "project" ? project() : undefined;
    if (
      !available() ||
      !current?.home ||
      (scope() === "project" && !currentProject)
    )
      return "";
    return JSON.stringify({
      machineId: current.id,
      home: current.home,
      scope: scope(),
      projectId: currentProject?.id,
    } satisfies SkillTarget);
  });
  const filesAt =
    (target: SkillTarget): SkillCall =>
    async <T,>(action: string, input: Record<string, unknown>) =>
      (await host.call<{ result: T }>("skills", action, { target, input }))
        .result;

  effect(() => {
    const locationKey = location();
    retry();
    host.subscriptionWire();
    selectedPath.set("");
    entries.set([]);
    resolved.set(undefined);
    missing.set(false);
    loading.set(Boolean(locationKey));
    failure.set("");
    if (!locationKey) return;
    let active = true;
    cleanup(() => {
      active = false;
    });
    const target = JSON.parse(locationKey) as SkillTarget;
    void (async () => {
      try {
        const loaded: SkillSummary[] = [];
        let offset: number | null = 0;
        let resolvedTarget = target;
        do {
          const reply: { target: SkillTarget; result: SkillList } =
            await host.call("skills", "list", {
              target: resolvedTarget,
              input: { offset },
            });
          if (!active) return;
          loaded.push(...reply.result.entries);
          if (!reply.result.exists) missing.set(true);
          resolvedTarget = reply.target;
          offset = reply.result.next;
        } while (offset !== null);
        resolved.set(resolvedTarget);
        entries.set(loaded);
      } catch (error) {
        if (active)
          failure.set(error instanceof Error ? error.message : String(error));
      } finally {
        if (active) loading.set(false);
      }
    })();
  });

  const refresh = () => {
    selectedPath.set("");
    retry.update((value) => value + 1);
  };
  const visible = () => {
    const term = query().trim().toLowerCase();
    return entries().filter((entry) =>
      `${entry.name} ${entry.description}`.toLowerCase().includes(term),
    );
  };

  function deviceMenu(width: 160 | "100%") {
    return (
      <If
        when={phone()}
        else={
          <SkillSelect
            label={uiText("skillDevice")}
            placeholder={uiText("skillChooseDevice")}
            value={machine()?.id}
            items={devices().map((item) => ({
              value: item.id,
              title: item.name,
              suffix:
                item.kind === "primary"
                  ? uiText("skillPrimaryDevice")
                  : undefined,
            }))}
            triggerStyle={{ width }}
            onChange={(id) => {
              selectedPath.set("");
              projectId.set("");
              device.set(id);
            }}
          />
        }
      >
        <ActionMenu
          label={uiText("skillDevice")}
          value={machine()?.name ?? uiText("skillHost")}
          truncateValue
          triggerStyle={{
            width,
            height: space[32],
            paddingHorizontal: space[8],
            borderColor: c().border,
          }}
        >
          <Each of={devices()} key={(item) => item.id}>
            {(item) => (
              <ActionItem
                label={item().name}
                checked={machine()?.id === item().id}
                onSelect={() => {
                  selectedPath.set("");
                  projectId.set("");
                  device.set(item().id);
                }}
              />
            )}
          </Each>
        </ActionMenu>
      </If>
    );
  }

  const changeScope = (value: "personal" | "project") => {
    selectedPath.set("");
    scope.set(value);
  };
  const controls = () => (
    <View
      style={{
        ...(tablet() || phone() ? {} : { ...row }),
        alignItems: tablet() || phone() ? "stretch" : "center",
        flexWrap: tablet() || phone() ? "nowrap" : "wrap",
        gap: tablet() || phone() ? space[8] : space[12],
        paddingHorizontal: tablet()
          ? space[16]
          : phone()
            ? space[16]
            : space[24],
        paddingTop: tablet() ? space[12] : space[8],
        paddingBottom: tablet() ? space[12] : phone() ? space[12] : space[16],
        borderBottomWidth: tablet() ? 1 : 0,
        borderColor: c().border,
      }}
    >
      <If when={tablet() || phone()}>{deviceMenu("100%")}</If>
      <View
        style={{
          ...row,
          alignSelf: "flex-start",
          backgroundColor: c().selected,
          padding: space[2],
        }}
      >
        <Each of={["personal", "project"] as const}>
          {(item) => (
            <View
              role="button"
              accessibilityLabel={uiText(
                item() === "personal" ? "personal" : "project2",
              )}
              accessibilityState={{ selected: scope() === item() }}
              onPress={() => changeScope(item())}
              style={{
                paddingHorizontal: space[12],
                paddingVertical: space[4],
                borderWidth: 1,
                borderColor: scope() === item() ? c().strong : "transparent",
                backgroundColor: scope() === item() ? c().canvas : undefined,
                cursor: "pointer",
              }}
            >
              <Label
                variant="caption"
                tone={scope() === item() ? "ink" : "muted"}
              >
                {uiText(item() === "personal" ? "personal" : "project2")}
              </Label>
            </View>
          )}
        </Each>
      </View>
      <If when={scope() === "project"}>
        <If
          when={phone()}
          else={
            <SkillSelect
              label={uiText("skillProjectMenu")}
              placeholder={uiText("skillChooseProject")}
              value={project()?.id}
              items={projects().map((item) => ({
                value: item.id,
                title: `${item.name} · ${item.display}`,
              }))}
              triggerStyle={{ width: tablet() ? "100%" : projectSelectWidth }}
              onChange={(id) => {
                selectedPath.set("");
                projectId.set(id);
              }}
            />
          }
        >
          <ActionMenu
            label={uiText("skillProjectMenu")}
            value={
              project()
                ? `${project()!.name} · ${project()!.display}`
                : uiText("skillChooseProject")
            }
            truncateValue
            triggerStyle={{
              width: "100%",
              height: control.md,
              paddingHorizontal: space[8],
            }}
          >
            <Each of={projects()} key={(item) => item.id}>
              {(item) => (
                <ActionItem
                  label={item().name}
                  checked={item().id === project()?.id}
                  onSelect={() => {
                    selectedPath.set("");
                    projectId.set(item().id);
                  }}
                />
              )}
            </Each>
          </ActionMenu>
        </If>
      </If>
      <If when={!tablet() && !phone()}>
        <View style={{ flex: 1 }} />
      </If>
      <View style={{ width: tablet() || phone() ? "100%" : searchWidth }}>
        <Field
          label={uiText("searchLoadedSkills")}
          placeholder={uiText("searchLoadedSkills")}
          value={query()}
          onChange={query.set}
          style={{
            width: "100%",
            height: phone() ? space[32] : control.md,
            fontSize: type("small").size,
            paddingRight: space[24],
          }}
        />
        <View
          style={{
            position: "absolute",
            right: 8,
            top: phone() ? 10 : 8,
            pointerEvents: "none",
          }}
        >
          <Icon name="search" size={icon.sm} />
        </View>
      </View>
    </View>
  );

  // What the list slot shows with no skills to list: one state at a time,
  // under the controls, as the design draws it.
  const emptyCopy = (): { title: string; hint?: string } => {
    if (!available()) return { title: uiText("thisHostDoesNotProvideSkill") };
    if (!machine())
      return {
        title: uiText("skillChooseDevice"),
        hint: uiText("skillChooseDeviceHint"),
      };
    if (scope() === "project" && !project())
      return {
        title: uiText("skillChooseProject"),
        hint: uiText("skillChooseProjectHint"),
      };
    if (!location()) return { title: uiText("skillDirectoryUnavailable") };
    if (missing())
      return {
        title: uiText("skillDirectoryMissing"),
        hint: uiText("skillDirectoryMissingHint"),
      };
    if (query().trim() && entries().length)
      return {
        title: uiText("noMatchingSkills"),
        hint: uiText("noMatchingSkillsHint"),
      };
    return {
      title: uiText("noSkillsInThisDirectory"),
      hint: uiText("noSkillsHint"),
    };
  };
  const emptyStyle = {
    flex: undefined,
    justifyContent: "flex-start",
    paddingVertical: space[40],
  } as const;
  const emptyWidth = () => (tablet() ? 220 : phone() ? 240 : 260);
  const emptyState = () => (
    <If
      when={!loading()}
      else={
        <ListSkeleton
          label={uiText("loadingSkills")}
          style={{
            paddingHorizontal: tablet()
              ? space[8]
              : phone()
                ? space[8]
                : space[16],
          }}
        />
      }
    >
      <If
        when={failure()}
        else={
          <Empty
            title={emptyCopy().title}
            description={emptyCopy().hint}
            icon="book"
            iconSize={icon.xl}
            titleWeight={weight.regular}
            titleTone="ink"
            descriptionWidth={emptyWidth()}
            style={emptyStyle}
          />
        }
      >
        <Empty
          title={uiText("unableToLoadSkills")}
          description={failure()}
          icon="warning"
          iconSize={icon.xl}
          iconTone="red"
          descriptionWidth={emptyWidth()}
          style={emptyStyle}
        >
          <Button label={uiText("retry")} size={control.md} onPress={refresh} />
        </Empty>
      </If>
    </If>
  );
  const list = () => (
    <>
      {controls()}
      <If when={visible().length} else={emptyState()}>
        <SmoothScroll style={grow} scrollbar={false}>
          <View
            style={
              tablet()
                ? {}
                : phone()
                  ? { borderBottomWidth: 1, borderColor: c().border }
                  : {
                      ...row,
                      flexWrap: "wrap",
                      alignItems: "stretch",
                      paddingHorizontal: space[24],
                      gap: space[12],
                    }
            }
          >
            <Each of={visible()} key={(entry) => entry.path}>
              {(entry) => (
                <View
                  role="button"
                  accessibilityLabel={entry().name}
                  accessibilityState={{
                    selected: selectedPath() === entry().path,
                  }}
                  onPress={() => selectedPath.set(entry().path)}
                  hoverStyle={{ backgroundColor: c().selected }}
                  style={{
                    ...(tablet()
                      ? {
                          ...row,
                          paddingHorizontal: space[16],
                          minHeight: tabletRowHeight,
                          borderBottomWidth: 1,
                          gap: space[8],
                        }
                      : phone()
                        ? {
                            ...row,
                            paddingHorizontal: space[16],
                            height: space[64],
                            borderTopWidth: 1,
                            gap: space[12],
                          }
                        : {
                            width: cardWidth,
                            padding: space[12],
                            borderWidth: 1,
                          }),
                    borderColor: c().border,
                    backgroundColor:
                      selectedPath() === entry().path
                        ? c().selected
                        : c().canvas,
                    cursor: "pointer",
                  }}
                >
                  <If when={tablet() || phone()}>
                    <View
                      style={{
                        width: phone() ? space[32] : control.md,
                        height: phone() ? space[32] : control.md,
                        alignItems: "center",
                        justifyContent: "center",
                        borderWidth: 1,
                        borderColor: c().border,
                        backgroundColor: c().selected,
                      }}
                    >
                      <View style={{ opacity: opacity.muted }}>
                        <Icon name="scroll" size={icon.md} tone="mutedInk" />
                      </View>
                    </View>
                  </If>
                  <View
                    style={{
                      flex: 1,
                      minWidth: 0,
                      gap: tablet() || phone() ? space[2] : space[4],
                    }}
                  >
                    <Label weight={weight.regular} lines={1}>
                      {entry().name}
                    </Label>
                    <Label
                      variant="small"
                      tone="muted"
                      lines={tablet() || phone() ? 1 : 2}
                      style={{
                        height: tablet() || phone() ? undefined : space[32],
                      }}
                    >
                      {entry().description}
                    </Label>
                  </View>
                  <If when={phone()}>
                    <Icon name="right" size={icon.md} />
                  </If>
                </View>
              )}
            </Each>
          </View>
        </SmoothScroll>
      </If>
    </>
  );
  const reader = () => (
    <Each of={showing() ? [selected()!] : []} key={(item) => item.path}>
      {(item) => {
        const call = filesAt(untracked(resolved)!);
        return (
          <SkillDetail
            skill={item()}
            call={call}
            layout={props.layout}
            location={machineLabel()}
            scope={scopeLabel()}
            onClose={() => selectedPath.set("")}
          />
        );
      }}
    </Each>
  );

  return (
    <If
      when={tablet()}
      else={
        <>
          <If when={phone() && !showing()}>
            <Header
              title={uiText("plugins")}
              layout="phone"
              onBack={props.onBack}
            >
              <Button
                label={uiText("skillReload")}
                icon="refresh"
                iconOnly
                iconSize={icon.md}
                size={control.lg}
                onPress={refresh}
              />
            </Header>
            {props.tabs()}
          </If>
          <If when={!phone()}>
            <Header
              title={uiText("plugins")}
              layout={props.layout}
              inset={space[12]}
            >
              <View style={{ flex: 1 }} />
              <If when={!showing()}>
                <View style={{ ...row, gap: space[12] }}>
                  {deviceMenu(160)}
                  <Button
                    label={uiText("skillReload")}
                    icon="refresh"
                    iconOnly
                    iconSize={icon.md}
                    size={control.sm}
                    style={{ paddingHorizontal: 0 }}
                    tone="ghost"
                    onPress={refresh}
                  />
                </View>
              </If>
            </Header>
            {props.tabs()}
          </If>
          <If when={showing()} else={list()}>
            {reader()}
          </If>
        </>
      }
    >
      <View style={{ ...row, ...grow, alignItems: "stretch" }}>
        <View
          style={{
            width: sizes.tabletList,
            flexShrink: 0,
            borderRightWidth: 1,
            borderColor: c().border,
          }}
        >
          <Header
            title={uiText("skillsTab")}
            count={entries().length}
            layout="tablet"
            background="canvas"
            inset={space[16]}
            end={space[12]}
          >
            <View style={{ flex: 1 }} />
            <Button
              label={uiText("skillReload")}
              icon="refresh"
              iconOnly
              onPress={refresh}
            />
          </Header>
          {props.tabs()}
          {list()}
        </View>
        <View style={grow}>
          <If
            when={showing()}
            else={
              <If
                when={visible().length}
                else={
                  // Nothing listed: the detail pane keeps only its blank header bar.
                  <View
                    style={{
                      height: space[40],
                      flexShrink: 0,
                      backgroundColor: c().surface,
                      borderBottomWidth: 1,
                      borderColor: c().border,
                    }}
                  />
                }
              >
                <Empty title={uiText("skillSelect")} icon="folder" />
              </If>
            }
          >
            {reader()}
          </If>
        </View>
      </View>
    </If>
  );
}
