import type {
  BriefView,
  RoutineInfo,
  RoutinesStatus,
  RoutineSummary,
  RunView,
} from "@eta/client-contracts";
import type { Layout } from "../../components";
import { Scroll, signal, View, windowSize } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  Empty,
  grow,
  Header,
  Label,
  Markdown,
  Modal,
  row,
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
          : props.layout !== "desktop" && info()
            ? info()!.name
            : uiText("routines2")
      }
      layout={props.layout}
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
      <If when={phone() && !selected()}>
        <Label size={11} tone="muted">
          {uiText("pending")}
        </Label>
        <ActionMenu
          label={uiText("routineActions")}
          triggerStyle={{ minWidth: 24, paddingHorizontal: 3 }}
        >
          <ActionItem
            label={uiText("newRoutine")}
            onSelect={() => editing.set("new")}
          />
        </ActionMenu>
      </If>
      <If when={phone() && info() && !current()}>
        <ActionMenu label={uiText("routineActions")}>
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
      <If when={props.layout === "tablet" && !editing()}>
        <Button
          label="Captain"
          tone="ghost"
          size={26}
          onPress={props.onCaptain}
        />
        <Button
          label={uiText("panel")}
          icon="sidebar"
          onPress={() => drawer.set(true)}
        />
      </If>
    </Header>
  );
  const pauseBanner = () => (
    <If when={paused() && !current()}>
      <View
        style={{
          paddingHorizontal: phone() ? 12 : props.layout === "tablet" ? 14 : 11,
          paddingVertical: props.layout === "desktop" ? 7 : 12,
          marginHorizontal: phone() ? 16 : props.layout === "tablet" ? 12 : 21,
          marginTop: props.layout === "desktop" ? 11 : 12,
          marginBottom: phone() ? 4 : props.layout === "tablet" ? 12 : 0,
          gap: 4,
          borderWidth: 1,
          borderColor: `${c().amber}66`,
          backgroundColor: c().amberFill,
        }}
      >
        <Label size={props.layout === "tablet" ? 13 : 14} weight={600}>
          {uiText("captainIsOffSoRoutinesAre")}
        </Label>
        <Label size={12} line={16} tone="mutedInk">
          {status()?.reason === "no_model"
            ? uiText("captainHasNoModelChooseOne")
            : uiText("turnOnCaptainToResumeRoutines")}
        </Label>
        <If
          when={
            status()?.reason === "supervisor_off" &&
            host.can("captain.setSetting")
          }
        >
          <Button
            label={uiText("turnCaptainOn")}
            size={28}
            style={{ alignSelf: "flex-start" }}
            onPress={() =>
              void host.action(() =>
                host.call("captain", "setSetting", {
                  key: "supervisorEnabled",
                  value: true,
                }),
              )
            }
          />
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
                    width:
                      props.layout === "desktop"
                        ? 352
                        : windowSize().width < 960
                          ? 280
                          : 320,
                    flexShrink: 0,
                  }),
              borderRightWidth: phone() ? 0 : 1,
              borderColor: c().border,
            }}
          >
            <If when={props.layout === "tablet"}>
              <Header
                title={uiText("routines2")}
                count={list().length}
                layout="tablet"
                inset={14}
              >
                <View style={{ flex: 1 }} />
                <Button
                  icon="plus"
                  label={uiText("newRoutine")}
                  iconOnly
                  size={28}
                  tone="ghost"
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
                >
                  <If when={host.can("routines.create") && !editing()}>
                    <Button
                      label={uiText("newRoutine")}
                      icon="plus"
                      onPress={() => editing.set("new")}
                    />
                  </If>
                </Empty>
              }
            >
              <Scroll style={grow} scrollbar={false}>
                <View style={{ paddingTop: phone() ? 0 : 8 }}>
                  <Each of={list()} key={(item) => item.id}>
                    {(item) => (
                      <If
                        when={phone()}
                        else={
                          <RoutineRow
                            item={item()}
                            selected={selected() === item().id}
                            paused={!!paused()}
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
                  />
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
