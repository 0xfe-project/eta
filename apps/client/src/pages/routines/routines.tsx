import type {
  BriefView,
  RoutineInfo,
  RoutinesStatus,
  RoutineSummary,
  RunView,
} from "@eta/client-contracts";
import type { Layout } from "../../components";
import { effect, signal, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  DetailSkeleton,
  dialogWidth,
  focusRing,
  grow,
  Header,
  Icon,
  Label,
  ListSkeleton,
  Modal,
  row,
  sizes,
  SmoothScroll,
} from "../../components";
import { EmptyState } from "../../components/empty-state";
import { chatText, shownMentions } from "../../components/eta-editor";
import { settled } from "../../components/pending";
import { dotSize } from "../../components/status-dot";
import { showToast } from "../../components/toast";
import { control, icon, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useAgentMentions } from "../../services/agent-mentions";
import { follow, useHost } from "../../services/host";
import { useLoadState } from "../../services/load-status";
import { DeleteRoutine } from "./delete-routine";
import { RoutineEditor } from "./editor";
import { PhoneRoutineRow } from "./history";
import { RoutineRow } from "./list-row";
import { PendingReports } from "./pending-reports";
import { RoutineDetail } from "./routine-detail";
import { RoutineReport } from "./run-report";

/** How far down an empty state stands: lower in a tablet's detail column, level with the
 * list's first rows. */

/** The desktop's list of routines. */
const listWidth = 352;
/** The tablet's Captain chip in the list header. */
const captainChipWidth = 160;
/** The brief, read in a dialog. */
const briefDialogHeight = 460;

export function Routines(props: {
  layout: Layout;
  initialId?: string;
  onCaptain: () => void;
  onBack?: () => void;
}) {
  const agentMentions = useAgentMentions();
  const host = useHost();
  const c = colors();
  const selected = signal(props.initialId ?? "");
  const editing = signal<"new" | "edit" | null>(null);
  const drawer = signal(false);
  // The routine the delete dialog asks about, kept as it was when asked.
  const deleting = signal<RoutineInfo | null>(null);
  const readingBrief = signal(false);
  const list = () => host.list<RoutineSummary>("routines");
  follow(() => "routines");
  const target = () => (selected() ? `routines.${selected()}` : undefined);
  follow(target);
  const listLoad = useLoadState({ targets: () => ["routines"] });
  const detailLoad = useLoadState({ targets: () => [target()] });
  /** No routine at all and none being made: one column, the empty state, no blank detail pane. */
  const none = () =>
    listLoad.status() !== "ready" ? false : !list().length && !editing();
  const briefs = () => host.list<BriefView>(target() ?? "", "briefs");
  const runs = () => host.list<RunView>(target() ?? "", "runs");
  const status = () => host.section<RoutinesStatus>("routines", "status");
  const listed = () => list().some((item) => item.id === selected());
  // A routine this page saw listed (or was opened on) that the list no longer has was deleted,
  // here or elsewhere. One just created is not listed yet and is not taken for gone.
  const seen = signal(props.initialId ?? "");
  effect(() => {
    if (selected() && listed()) seen.set(selected());
  });
  const gone = () =>
    !!selected() &&
    seen() === selected() &&
    !!host.state().targets.routines &&
    !listed() &&
    // Deleted from here: the page goes back to the list instead.
    deleting()?.id !== selected();
  const canDelete = () => host.can("routines.delete");
  const info = () =>
    gone() ? undefined : host.section<RoutineInfo>(target() ?? "", "info");
  const detailSettled = settled(() => !selected() || !!info() || gone());
  const report = signal("");
  const reportIndex = () =>
    gone() ? -1 : runs().findIndex((run) => run.id === report());
  const current = () => runs()[reportIndex()];
  const paused = () => status() && !status()?.captainOn;
  const phone = () => props.layout === "phone";
  const tablet = () => props.layout === "tablet";
  const attention = () =>
    list().some((item) => item.unseenReports || item.unseenFailures);
  const feedback = signal("");
  const starting = signal(false);
  const sendingFeedback = signal(false);
  const turningCaptainOn = signal(false);
  const canRun = () =>
    !!status()?.captainOn && !runs().some((run) => run.status === "running");
  function applyToggle(routineId: string, enabled: boolean) {
    void host
      .optimistic(routineId, { enabled }, () =>
        host.call("routines", "update", { routineId, enabled }),
      )
      .catch((problem: unknown) =>
        showToast({
          title: uiText("saveFailed"),
          body: problem instanceof Error ? problem.message : String(problem),
          tone: "red",
          action: {
            label: uiText("retry"),
            onPress: () => applyToggle(routineId, enabled),
          },
        }),
      );
  }
  function toggle(item: RoutineInfo) {
    applyToggle(item.id, !item.enabled);
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
    if (!canRun() || starting()) return;
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
      inset={tablet() ? space[12] : undefined}
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
          iconSize={icon.lg}
          iconOnly
          tone="ghost"
          style={{ width: space[40], height: space[40] }}
          onPress={() => editing.set("new")}
        />
      </If>
      <If when={phone() && info() && !current()}>
        <ActionMenu
          label={uiText("routineActions")}
          iconSize={icon.md}
          triggerStyle={{ width: space[40], height: space[40] }}
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
          <ActionItem
            label={uiText("deleteRoutineMenu")}
            tone="red"
            disabled={!canDelete()}
            onSelect={() => deleting.set(info() ?? null)}
          />
        </ActionMenu>
      </If>
      <If when={tablet()}>
        <View
          role="button"
          accessibilityLabel="Captain"
          onPress={props.onCaptain}
          hoverStyle={{ backgroundColor: c().selected }}
          focusVisibleStyle={focusRing(c(), "inset")}
          style={{
            ...row,
            flexShrink: 0,
            maxWidth: captainChipWidth,
            gap: space[4],
            paddingVertical: space[2],
            paddingHorizontal: space[8],
            borderWidth: 1,
            borderColor: c().border,
            cursor: "pointer",
          }}
        >
          <Icon name="folder" size={icon.sm} tone="muted" />
          <Label variant="small" tone="muted" lines={1}>
            Captain
          </Label>
        </View>
        <View style={{ flex: 1 }} />
        <View style={{ flexShrink: 0 }}>
          <Button
            label={uiText("panel")}
            icon="sidebar"
            iconSize={icon.md}
            labelVariant="caption"
            style={{ gap: space[4] }}
            onPress={() => drawer.set(true)}
          />
          <If when={attention()}>
            <View
              style={{
                position: "absolute",
                top: -space[4],
                right: -space[4],
                width: dotSize,
                height: dotSize,
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
            ? { ...row, gap: space[12] }
            : { gap: tablet() ? space[8] : space[4] }),
          paddingHorizontal: phone()
            ? space[12]
            : props.layout === "tablet"
              ? space[16]
              : space[12],
          paddingTop: props.layout === "desktop" ? space[8] : space[12],
          // The phone notice without a button ends on a 6px spacer under its text.
          paddingBottom:
            props.layout === "desktop"
              ? space[8]
              : phone() && !turnOn()
                ? space[20]
                : space[12],
          marginHorizontal: phone()
            ? space[16]
            : props.layout === "tablet"
              ? space[12]
              : space[20],
          marginTop: props.layout === "desktop" ? space[12] : space[12],
          marginBottom: phone()
            ? space[4]
            : props.layout === "tablet"
              ? space[12]
              : 0,
          borderWidth: 1,
          borderColor: c().warningLine,
          backgroundColor: c().warningFill,
        }}
      >
        <View
          style={{
            gap: props.layout === "desktop" ? 0 : space[4],
            ...(props.layout === "desktop" ? { flex: 1, minWidth: 0 } : {}),
          }}
        >
          <Label
            weight={props.layout === "desktop" ? weight.regular : weight.strong}
          >
            {uiText("captainIsOffSoRoutinesAre")}
          </Label>
          <Label
            variant="small"
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
              paddingTop: phone() ? space[8] : 0,
            }}
          >
            <Button
              label={uiText("turnCaptainOn")}
              size={phone() ? control.touch : control.md}
              style={{ paddingHorizontal: phone() ? space[16] : space[12] }}
              busy={turningCaptainOn()}
              onPress={() => {
                if (turningCaptainOn()) return;
                turningCaptainOn.set(true);
                void host
                  .action(() =>
                    host.call("captain", "setSetting", {
                      key: "supervisorEnabled",
                      value: true,
                    }),
                  )
                  .finally(() => turningCaptainOn.set(false));
              }}
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
              ...(phone() || none()
                ? grow
                : {
                    width:
                      props.layout === "desktop" ? listWidth : sizes.tabletList,
                    flexShrink: 0,
                  }),
              borderRightWidth: phone() || none() ? 0 : 1,
              borderColor: c().border,
            }}
          >
            <If when={props.layout === "tablet"}>
              <Header
                title={uiText("routines2")}
                count={list().length || undefined}
                layout="tablet"
                background="none"
                inset={space[16]}
                end={space[12]}
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
                <EmptyState
                  size="page"
                  status={listLoad.shown()}
                  loading={<ListSkeleton label={uiText("loadingRoutines")} />}
                  error={{
                    title: uiText("routinesDidNotLoad"),
                    description: listLoad.why(),
                    retry: listLoad.retry,
                    retrying: listLoad.retrying(),
                  }}
                  empty={{
                    art: "routines",
                    title: uiText("noRoutinesYet"),
                    description: uiText("emptyRoutineHelp"),
                    actions:
                      host.can("routines.create") && !editing()
                        ? [
                            {
                              label: uiText("newRoutine"),
                              icon: "plus",
                              onPress: () => editing.set("new"),
                            },
                          ]
                        : undefined,
                  }}
                />
              }
            >
              <SmoothScroll style={grow} scrollbar={false}>
                <View
                  style={
                    props.layout === "desktop"
                      ? {
                          paddingVertical: space[12],
                          paddingHorizontal: space[16],
                        }
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
              </SmoothScroll>
            </If>
          </View>
        </If>
        <If when={(!phone() && !none()) || selected()}>
          <View style={grow}>
            <If when={props.layout === "tablet"}>
              {pageHeader()}
              {pauseBanner()}
            </If>
            <If when={!phone() && editing()}>{editor()}</If>
            <If when={(phone() && selected()) || (!phone() && !editing())}>
              <If
                when={detailSettled() ? info() : undefined}
                else={
                  <EmptyState
                    size="page"
                    status={
                      gone()
                        ? "error"
                        : selected()
                          ? detailLoad.status() === "error"
                            ? "error"
                            : "loading"
                          : "empty"
                    }
                    loading={
                      <DetailSkeleton label={uiText("loadingRoutine")} />
                    }
                    error={
                      gone() || detailLoad.failure() === "missing"
                        ? {
                            art: "routines",
                            tone: "quiet",
                            title: uiText("routineGoneTitle"),
                            description: uiText("routineGoneBody"),
                            actions: [
                              {
                                label: uiText("backToRoutines"),
                                icon: "arrowLeft",
                                onPress: () => select(""),
                              },
                            ],
                          }
                        : {
                            title: uiText("routineDidNotLoad"),
                            description: detailLoad.why(),
                            retry: detailLoad.retry,
                            retrying: detailLoad.retrying(),
                          }
                    }
                    empty={{
                      art: "routines",
                      title: uiText("selectARoutine"),
                      description: uiText("selectOneOnTheLeftTo"),
                    }}
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
                        firstBrief={briefs().at(-1)}
                        runs={runs()}
                        canRun={canRun()}
                        starting={starting()}
                        onRun={() => void retry(item().id)}
                        onReport={openReport}
                        onReadBrief={() => readingBrief.set(true)}
                        onEdit={() => editing.set("edit")}
                        canDelete={canDelete()}
                        onDelete={() => deleting.set(item())}
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
                      starting={starting()}
                      sendingFeedback={sendingFeedback()}
                      onRetry={() => void retry(item().id)}
                      onToggle={() => toggle(item())}
                      onEdit={() => {
                        openReport("");
                        editing.set("edit");
                      }}
                      feedback={feedback()}
                      onFeedback={feedback.set}
                      onSend={() => {
                        if (sendingFeedback() || !feedback().trim()) return;
                        sendingFeedback.set(true);
                        void host
                          .action(async () => {
                            await host.call("routines", "feedback", {
                              routineId: item().id,
                              runId: report(),
                              text: feedback().trim(),
                            });
                            feedback.set("");
                          })
                          .finally(() => sendingFeedback.set(false));
                      }}
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
          width={dialogWidth.xl}
          height={briefDialogHeight}
          phone={phone()}
          onClose={() => readingBrief.set(false)}
        >
          <SmoothScroll style={grow}>
            <View style={{ padding: space[16] }}>
              <chatText.View
                plugins={[shownMentions()]}
                text={{
                  text: briefs()[0]?.text ?? "",
                  mentions: agentMentions(),
                }}
                label={uiText("routineBrief")}
              />
            </View>
          </SmoothScroll>
        </Modal>
      </If>
      <If when={deleting()}>
        {(item) => (
          <DeleteRoutine
            routine={item()}
            running={runs().some((run) => run.status === "running")}
            phone={phone()}
            onClose={() => deleting.set(null)}
            onDeleted={(id) => {
              if (selected() === id) select("");
              deleting.set(null);
            }}
          />
        )}
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
