import type {
  BriefView,
  RoutineInfo,
  RoutinesStatus,
  RoutineSummary,
  RunView,
} from "@eta/client-contracts";
import type { Layout } from "../../components";
import { Scroll, signal, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  Empty,
  grow,
  Header,
  Icon,
  Label,
  Markdown,
  Modal,
  row,
  sizes,
} from "../../components";
import { uiText } from "../../i18n";
import { follow, useHost } from "../../services/host";
import { RoutineEditor } from "./editor";
import { PhoneRoutineRow } from "./history";
import { RoutineRow } from "./list-row";
import { PendingReports } from "./pending-reports";
import { RoutineDetail } from "./routine-detail";
import { RoutineReport } from "./run-report";

export function Routines(props: {
  layout: Layout;
  initialId?: string;
  onCaptain: () => void;
  onBack?: () => void;
}) {
  const host = useHost();
  const c = colors();
  const selected = signal(props.initialId ?? "");
  const editing = signal<"new" | "edit" | null>(null);
  const drawer = signal(false);
  const readingBrief = signal(false);
  const list = () => host.list<RoutineSummary>("routines");
  follow(() => "routines");
  const target = () => (selected() ? `routines.${selected()}` : undefined);
  follow(target);
  const info = () => host.section<RoutineInfo>(target() ?? "", "info");
  const briefs = () => host.list<BriefView>(target() ?? "", "briefs");
  const runs = () => host.list<RunView>(target() ?? "", "runs");
  const status = () => host.section<RoutinesStatus>("routines", "status");
  const report = signal("");
  const reportIndex = () => runs().findIndex((run) => run.id === report());
  const current = () => runs()[reportIndex()];
  const paused = () => status() && !status()?.captainOn;
  const phone = () => props.layout === "phone";
  const tablet = () => props.layout === "tablet";
  const attention = () =>
    list().some((item) => item.unseenReports || item.unseenFailures);
  const feedback = signal("");
  const starting = signal(false);
  const canRun = () =>
    !!status()?.captainOn &&
    !starting() &&
    !runs().some((run) => run.status === "running");
  function toggle(item: RoutineInfo) {
    void host.action(() =>
      host.call("routines", "update", {
        routineId: item.id,
        enabled: !item.enabled,
      }),
    );
  }
  function select(id: string) {
    selected.set(id);
    report.set("");
    feedback.set("");
    if (id)
      void host.action(() => host.call("routines", "seen", { routineId: id }));
  }
  function openReport(id: string) {
    report.set(id);
    feedback.set("");
  }

  async function retry(routineId: string) {
    if (!canRun()) return;
    starting.set(true);
    const result = await host.action(() =>
      host.call<{ run: { id: string } }>("routines", "run", { routineId }),
    );
    starting.set(false);
    if (result) openReport(result.run.id);
  }

  function editor() {
    return (
      <RoutineEditor
        phone={phone()}
        inline={!phone()}
        tablet={tablet()}
        item={editing() === "edit" ? info() : undefined}
        brief={editing() === "edit" ? briefs()[0]?.text : undefined}
        onClose={() => editing.set(null)}
        onSave={select}
      />
    );
  }

  const pageHeader = () => (
    <Header
      title={
        phone() && current()
          ? uiText("runReport")
          : tablet() && editing() === "new"
            ? uiText("newRoutine")
            : props.layout !== "desktop" && info()
              ? info()!.name
              : uiText("routines2")
      }
      layout={props.layout}
      inset={tablet() ? 10 : undefined}
      onBack={
        phone() && current()
          ? () => openReport("")
          : phone() && selected()
            ? () => select("")
            : props.onBack
      }
    >
      <If when={props.layout === "desktop"}>
        <Button
          label={uiText("newRoutine")}
          icon="plus"
          tone="primary"
          onPress={() => editing.set("new")}
        />
      </If>
      <If when={phone() && !selected() && host.can("routines.create")}>
        <Button
          label={uiText("newRoutine")}
          icon="plus"
          iconSize={20}
          iconOnly
          tone="ghost"
          style={{ width: 40, height: 40 }}
          onPress={() => editing.set("new")}
        />
      </If>
      <If when={phone() && info() && !current()}>
        <ActionMenu
          label={uiText("routineActions")}
          iconSize={18}
          triggerStyle={{ width: 40, height: 40 }}
        >
          <ActionItem
            label={info()?.enabled ? uiText("pause") : uiText("resume")}
            onSelect={() => {
              if (info()) toggle(info()!);
            }}
          />
          <ActionItem
            label={uiText("edit")}
            onSelect={() => editing.set("edit")}
          />
        </ActionMenu>
      </If>
      <If when={tablet()}>
        <View
          role="button"
          accessibilityLabel="Captain"
          onPress={props.onCaptain}
          hoverStyle={{ backgroundColor: c().selected }}
          focusVisibleStyle={{ outlineWidth: 1, outlineColor: c().blue }}
          style={{
            ...row,
            flexShrink: 0,
            maxWidth: 160,
            gap: 4,
            paddingVertical: 2,
            paddingHorizontal: 6,
            borderWidth: 1,
            borderColor: c().border,
            cursor: "pointer",
          }}
        >
          <Icon name="folder" size={12} tone="muted" />
          <Label size={12} line={16} tone="muted" lines={1}>
            Captain
          </Label>
        </View>
        <View style={{ flex: 1 }} />
        <View style={{ flexShrink: 0 }}>
          <Button
            label={uiText("panel")}
            icon="sidebar"
            iconSize={14}
            labelSize={11}
            style={{ gap: 6 }}
            onPress={() => drawer.set(true)}
          />
          <If when={attention()}>
            <View
              style={{
                position: "absolute",
                top: -3,
                right: -3,
                width: 6,
                height: 6,
                backgroundColor: c().blue,
              }}
            />
          </If>
        </View>
      </If>
    </Header>
  );
  const turnOn = () =>
    status()?.reason === "supervisor_off" && host.can("captain.setSetting");
  const pauseBanner = () => (
    <If when={paused() && !current()}>
      <View
        style={{
          // The desktop notice puts its button on the right; the others below the text.
          ...(props.layout === "desktop"
            ? { ...row, gap: 12 }
            : { gap: tablet() ? 10 : 6 }),
          paddingHorizontal: phone() ? 12 : props.layout === "tablet" ? 14 : 11,
          paddingTop: props.layout === "desktop" ? 7 : 12,
          // The phone notice without a button ends on a 6px spacer under its text.
          paddingBottom:
            props.layout === "desktop" ? 7 : phone() && !turnOn() ? 18 : 12,
          marginHorizontal: phone() ? 16 : props.layout === "tablet" ? 12 : 21,
          marginTop: props.layout === "desktop" ? 11 : 12,
          marginBottom: phone() ? 4 : props.layout === "tablet" ? 12 : 0,
          borderWidth: 1,
          // state-warning at 40% and 12%.
          borderColor: `${c().warning}66`,
          backgroundColor: `${c().warning}1f`,
        }}
      >
        <View
          style={{
            gap: props.layout === "desktop" ? 0 : phone() ? 6 : 4,
            ...(props.layout === "desktop" ? { flex: 1, minWidth: 0 } : {}),
          }}
        >
          <Label
            size={tablet() ? 13 : 14}
            line={tablet() ? 18 : phone() ? 20 : undefined}
            weight={props.layout === "desktop" ? 500 : 600}
          >
            {uiText("captainIsOffSoRoutinesAre")}
          </Label>
          <Label
            size={tablet() ? 11 : 12}
            line={phone() ? 18 : 16}
            tone={props.layout === "desktop" ? "muted" : "mutedInk"}
          >
            {status()?.reason === "no_model"
              ? uiText("captainHasNoModelChooseOne")
              : status()?.reason === "supervisor_off"
                ? uiText("captainSupervisorOff")
                : uiText("turnOnCaptainToResumeRoutines")}
          </Label>
        </View>
        <If when={turnOn()}>
          <View
            style={{
              ...row,
              flexShrink: 0,
              paddingTop: phone() ? 6 : 0,
            }}
          >
            <Button
              label={uiText("turnCaptainOn")}
              size={phone() ? 36 : 28}
              labelSize={phone() ? 14 : undefined}
              style={{ paddingHorizontal: phone() ? 14 : 12 }}
              onPress={() =>
                void host.action(() =>
                  host.call("captain", "setSetting", {
                    key: "supervisorEnabled",
                    value: true,
                  }),
                )
              }
            />
          </View>
        </If>
      </View>
    </If>
  );
  return (
    <View style={grow}>
      <If when={props.layout !== "tablet"}>
        {pageHeader()}
        {pauseBanner()}
      </If>
      <View style={{ ...row, ...grow, alignItems: "stretch" }}>
        <If when={!phone() || !selected()}>
          <View
            style={{
              ...(phone()
                ? grow
                : {
                    width: props.layout === "desktop" ? 352 : sizes.tabletList,
                    flexShrink: 0,
                  }),
              borderRightWidth: phone() ? 0 : 1,
              borderColor: c().border,
            }}
          >
            <If when={props.layout === "tablet"}>
              <Header
                title={uiText("routines2")}
                count={list().length || undefined}
                layout="tablet"
                background="none"
                inset={14}
                end={10}
              >
                <View style={{ flex: 1 }} />
                <Button
                  icon="plus"
                  label={uiText("newRoutine")}
                  iconOnly
                  style={{ backgroundColor: "transparent" }}
                  onPress={() => editing.set("new")}
                />
              </Header>
            </If>
            <If
              when={list().length}
              else={
                <Empty
                  title={
                    host.state().targets.routines
                      ? uiText("noRoutinesYet")
                      : uiText("loadingRoutine")
                  }
                  description={
                    host.state().targets.routines
                      ? uiText("emptyRoutineHelp")
                      : undefined
                  }
                  icon="routines"
                  iconSize={24}
                  iconTone="ink"
                  titleSize={tablet() ? 13 : 14}
                  titleLine={tablet() ? 18 : 20}
                  titleWeight={tablet() ? 400 : 500}
                  descriptionSize={tablet() ? 11 : 12}
                  descriptionLine={phone() ? 18 : 16}
                  descriptionWidth={400}
                  // The list's empty state sits at the top of the column.
                  style={{
                    flex: 0,
                    justifyContent: "flex-start",
                    paddingTop: phone() ? 56 : tablet() ? 48 : 59,
                    paddingBottom: phone() ? 24 : 0,
                    paddingHorizontal: phone() ? 32 : tablet() ? 20 : 30,
                  }}
                >
                  <If when={host.can("routines.create") && !editing()}>
                    <View style={{ ...row, paddingTop: 8 }}>
                      <Button
                        label={uiText("newRoutine")}
                        icon="plus"
                        tone="primary"
                        size={phone() ? 36 : tablet() ? 28 : 24}
                        iconSize={phone() ? 14 : 12}
                        labelSize={phone() ? 14 : 12}
                        style={{
                          paddingHorizontal: phone() ? 14 : tablet() ? 12 : 8,
                          gap: phone() ? 6 : 4,
                        }}
                        onPress={() => editing.set("new")}
                      />
                    </View>
                  </If>
                </Empty>
              }
            >
              <Scroll style={grow} scrollbar={false}>
                <View
                  style={
                    props.layout === "desktop"
                      ? { paddingVertical: 11, paddingHorizontal: 14 }
                      : phone() && paused()
                        ? { borderTopWidth: 1, borderColor: c().border }
                        : undefined
                  }
                >
                  <Each of={list()} key={(item) => item.id}>
                    {(item) => (
                      <If
                        when={phone()}
                        else={
                          <RoutineRow
                            item={item()}
                            selected={selected() === item().id}
                            paused={!!paused()}
                            tablet={tablet()}
                            onOpen={() => select(item().id)}
                          />
                        }
                      >
                        <PhoneRoutineRow
                          item={item()}
                          paused={!!paused()}
                          onOpen={() => select(item().id)}
                        />
                      </If>
                    )}
                  </Each>
                </View>
              </Scroll>
            </If>
          </View>
        </If>
        <If when={!phone() || selected()}>
          <View style={grow}>
            <If when={props.layout === "tablet"}>
              {pageHeader()}
              {pauseBanner()}
            </If>
            <If when={!phone() && editing()}>{editor()}</If>
            <If when={(phone() && selected()) || (!phone() && !editing())}>
              <If
                when={info()}
                else={
                  <If when={selected() || list().length}>
                    <Empty
                      title={
                        selected()
                          ? uiText("loadingRoutine")
                          : uiText("selectARoutine")
                      }
                      description={
                        selected() ? undefined : uiText("selectOneOnTheLeftTo")
                      }
                      icon="routines"
                      iconSize={selected() ? undefined : 24}
                      iconTone={selected() ? undefined : "ink"}
                      titleSize={tablet() ? 13 : undefined}
                      titleLine={tablet() ? undefined : 20}
                      titleWeight={tablet() ? 400 : undefined}
                      descriptionSize={tablet() ? 11 : undefined}
                      descriptionLine={16}
                      // Two lines on the desktop; tablet runs it across the pane.
                      descriptionWidth={tablet() ? 560 : 230}
                      style={
                        selected()
                          ? undefined
                          : {
                              justifyContent: "flex-start",
                              paddingTop: tablet() ? 110 : 60,
                              paddingHorizontal: tablet() ? 40 : undefined,
                            }
                      }
                    />
                  </If>
                }
              >
                {(item) => (
                  <If
                    when={current()}
                    else={
                      <RoutineDetail
                        layout={props.layout}
                        routine={item()}
                        brief={briefs()[0]}
                        firstBrief={briefs().at(-1)}
                        runs={runs()}
                        canRun={canRun()}
                        onRun={() => void retry(item().id)}
                        onReport={openReport}
                        onReadBrief={() => readingBrief.set(true)}
                        onEdit={() => editing.set("edit")}
                        onToggle={() => toggle(item())}
                      />
                    }
                  >
                    <RoutineReport
                      routine={item()}
                      run={current()!}
                      index={reportIndex()}
                      count={runs().length}
                      phone={phone()}
                      runs={runs()}
                      onBack={() => openReport("")}
                      onMove={(by) => {
                        const run = runs()[reportIndex() + by];
                        if (run) openReport(run.id);
                      }}
                      canRetry={canRun()}
                      onRetry={() => void retry(item().id)}
                      onToggle={() => toggle(item())}
                      onEdit={() => {
                        openReport("");
                        editing.set("edit");
                      }}
                      feedback={feedback()}
                      onFeedback={feedback.set}
                      onSend={() =>
                        void host.action(async () => {
                          await host.call("routines", "feedback", {
                            routineId: item().id,
                            runId: report(),
                            text: feedback().trim(),
                          });
                          feedback.set("");
                        })
                      }
                    />
                  </If>
                )}
              </If>
            </If>
          </View>
        </If>
      </View>
      <If when={phone() && editing()}>{editor()}</If>
      <If when={readingBrief()}>
        <Modal
          title={uiText("routineBrief")}
          width={640}
          height={460}
          phone={phone()}
          onClose={() => readingBrief.set(false)}
        >
          <Scroll style={grow}>
            <View style={{ padding: 16 }}>
              <Markdown value={briefs()[0]?.text ?? ""} />
            </View>
          </Scroll>
        </Modal>
      </If>
      <If when={drawer()}>
        <PendingReports
          routines={list()}
          onClose={() => drawer.set(false)}
          onOpen={(routine, run) => {
            select(routine);
            openReport(run);
            drawer.set(false);
          }}
        />
      </If>
    </View>
  );
}
