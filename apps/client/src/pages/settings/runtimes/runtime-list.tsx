import type {
  AgentRuntimeAccount,
  AgentRuntimeInfo,
  MachineView,
  ProviderUsage,
} from "@eta/client-contracts";
import type { JSX } from "nsh";
import type { RuntimeListing } from "./listing";
import { signal, View } from "nsh";
import { Button, colors, Label, row } from "../../../components";
import { EmptyState } from "../../../components/empty-state";
import { ListSkeleton } from "../../../components/loading-skeleton";
import { StatusDot } from "../../../components/status-dot";
import { control, icon, space, weight } from "../../../components/tokens";
import { uiText } from "../../../i18n";
import { follow, useHost } from "../../../services/host";
import { useLoadState } from "../../../services/load-status";
import { problemText } from "../../../services/problem-text";
import { localTime, percentText } from "../models/quota";
import {
  emptyStyle,
  EntityRow,
  leadingBoxWidth,
  LetterBox,
  SectionHeader,
  WarningLine,
} from "../section";
import { tokens } from "../setting-row";
import { reachable } from "./listing";
import { runtimeLogo } from "./logos";
import { RuntimeWords } from "./runtime-hints";
import {
  LOGIN_COMMANDS,
  reasonText,
  reasonTone,
  runtimeReason,
} from "./status";

/** A runtime's status column: room for "Needs sign-in" and its dot. */
const runtimeLaneWidth = 152;

/** The CLI's own `--version` line may carry its name (`codex-cli 0.167.2`): the number alone. */
function versionOf(runtime: AgentRuntimeInfo) {
  const number = runtime.version?.match(/\d+\.\d[\w.+-]*/)?.[0];
  return number === undefined ? runtime.version : `v${number}`;
}

const custom = (runtime: AgentRuntimeInfo) => runtime.id.startsWith("acp.");

/** A small heading inside an open row. */
function Part(props: { title: string; children?: JSX.Element }) {
  return (
    <View style={{ gap: space[2] }}>
      <Label variant="small" weight={weight.regular}>
        {props.title}
      </Label>
      {props.children}
    </View>
  );
}

/** Who the runtime is signed in as, and how much of its plan is used: each only where it says. */
function AccountParts(props: {
  runtime: AgentRuntimeInfo;
  machine: MachineView;
  account: AgentRuntimeAccount;
}) {
  const auth = () => props.account.auth;
  const usage = () => props.account.usage;
  const command = () => LOGIN_COMMANDS[props.runtime.id];
  return (
    <>
      <If when={auth()}>
        {(value) => (
          <Part title={uiText("runtimeSignInTitle")}>
            <If
              when={value().kind === "logged_in"}
              else={
                <WarningLine
                  outline
                  text={[
                    value().kind === "logged_out"
                      ? uiText("runtimeSignedOut")
                      : uiText("runtimeAuthUnknown"),
                    (value() as { detail?: string }).detail,
                    command()
                      ? uiText("runtimeHowToSignIn", {
                          command: command()!,
                          machine: props.machine.name,
                        })
                      : undefined,
                  ]
                    .filter(Boolean)
                    .join(" ")}
                />
              }
            >
              <Label variant="small" tone="muted">
                {[
                  uiText("runtimeSignedIn"),
                  ...(value().kind === "logged_in"
                    ? [
                        (value() as { email?: string }).email,
                        (value() as { plan?: string }).plan,
                        (value() as { method?: string }).method,
                      ]
                    : []),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Label>
            </If>
          </Part>
        )}
      </If>
      <If when={usage()}>
        {(value) => (
          <Part title={uiText("runtimePlanUsage")}>
            <If
              when={value().kind === "available" ? value() : undefined}
              else={
                <Label variant="small" tone="muted">
                  {value().kind === "error"
                    ? (value() as { detail: string }).detail
                    : [
                        uiText(
                          value().kind === "reauth_required"
                            ? "runtimeReauthRequired"
                            : "runtimeUsageUnsupported",
                        ),
                        (value() as { reason?: string }).reason,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                </Label>
              }
            >
              {(available) => {
                const plan = available() as Extract<
                  AgentRuntimeAccount["usage"],
                  { kind: "available" }
                >;
                return (
                  <>
                    <If when={plan.plan || plan.email || plan.rateLimited}>
                      <Label variant="small" tone="muted">
                        {[
                          plan.plan,
                          plan.email,
                          plan.rateLimited
                            ? uiText("runtimeRateLimited")
                            : undefined,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </Label>
                    </If>
                    <Each of={plan.windows} key={(window) => window.label}>
                      {(window) => (
                        <Label variant="small" tone="muted">
                          {[
                            window().label,
                            uiText("modelQuotaUsed", {
                              percent: percentText(window().usedRatio * 100),
                            }),
                            window().resetsAt
                              ? uiText("modelQuotaResetsAt", {
                                  time: localTime(window().resetsAt),
                                })
                              : undefined,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </Label>
                      )}
                    </Each>
                  </>
                );
              }}
            </If>
          </Part>
        )}
      </If>
    </>
  );
}

/** What opens under a runtime's row: its account where it has one, its models, its own words. */
function RuntimeDetail(props: {
  listing: RuntimeListing;
  machine: MachineView;
  runtime: AgentRuntimeInfo;
  weekTokens: number | undefined;
  phone: boolean;
  onExternalAgent: (machineId: string, id: string) => void;
}) {
  const c = colors();
  // An external agent has no account to ask about, and a runtime that is not there has none either.
  const asksAccount = () =>
    !custom(props.runtime) && props.runtime.status !== "missing";
  const account = () => props.listing.account(props.machine, props.runtime.id);
  return (
    <View
      style={{
        gap: space[8],
        // Under the title: the row's inset, the icon's box and the gap after it.
        paddingLeft:
          space[16] + (props.phone ? control.md : space[24]) + space[8],
        paddingRight: space[16],
        paddingTop: space[2],
        paddingBottom: space[12],
        borderBottomWidth: 1,
        borderColor: c().border,
      }}
    >
      <If when={asksAccount()}>
        <If
          when={account()?.state === "ready" ? account() : undefined}
          else={
            <Label variant="small" tone="muted">
              {account()?.state === "error"
                ? (account() as { message: string }).message
                : uiText("modelReadLoading")}
            </Label>
          }
        >
          {(ready) => (
            <AccountParts
              runtime={props.runtime}
              machine={props.machine}
              account={(ready() as { account: AgentRuntimeAccount }).account}
            />
          )}
        </If>
      </If>
      <If when={props.weekTokens}>
        {(total) => (
          <Part title={uiText("runtimeModelUsage")}>
            <Label variant="small" tone="muted">
              {uiText("runtimeWeekUsage", { usage: tokens(total()) })}
            </Label>
          </Part>
        )}
      </If>
      <Part title={uiText("runtimeModels")}>
        <If
          when={props.runtime.models.length}
          else={
            <Label variant="small" tone="muted">
              {uiText("runtimeNoModels")}
            </Label>
          }
        >
          <Each of={props.runtime.models} key={(model) => model.id}>
            {(model) => (
              <Label variant="small" tone="muted">
                {[
                  model().name,
                  model().name === model().id ? undefined : model().id,
                  model().default ? uiText("runtimeDefaultModel") : undefined,
                  model().efforts.length
                    ? uiText("runtimeEfforts", {
                        levels: model().efforts.join(" / "),
                      })
                    : undefined,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Label>
            )}
          </Each>
        </If>
      </Part>
      <If when={props.runtime.detail}>
        {(detail) => (
          <Part title={uiText("runtimeDiagnostics")}>
            <RuntimeWords>{detail()}</RuntimeWords>
          </Part>
        )}
      </If>
      <If when={custom(props.runtime)}>
        <View style={{ ...row }}>
          <Button
            label={uiText("runtimeOpenExternalAgent")}
            tone="ghost"
            size={control.sm}
            labelTone="mutedInk"
            style={{ paddingHorizontal: 0 }}
            onPress={() =>
              props.onExternalAgent(
                props.machine.id,
                props.runtime.id.slice("acp.".length),
              )
            }
          />
        </View>
      </If>
    </View>
  );
}

function RuntimeRow(props: {
  listing: RuntimeListing;
  machine: MachineView;
  runtime: AgentRuntimeInfo;
  weekTokens: number | undefined;
  phone: boolean;
  onExternalAgent: (machineId: string, id: string) => void;
}) {
  const c = colors();
  const open = signal(false);
  const reason = () => runtimeReason(props.runtime);
  const meta = () =>
    [
      custom(props.runtime)
        ? uiText("runtimeCustom")
        : uiText("runtimeBuiltIn"),
      versionOf(props.runtime),
    ]
      .filter(Boolean)
      .join(" · ");
  return (
    <View>
      <EntityRow
        title={props.runtime.label}
        accessibilityLabel={`${props.runtime.label}, ${uiText(
          reason() ? reasonText[reason()!] : "runtimeAvailable",
        )}`}
        leading={
          <LetterBox
            name={props.runtime.label}
            logo={runtimeLogo(props.runtime.id, props.runtime.label)}
          />
        }
        leadingSize={props.phone ? leadingBoxWidth : undefined}
        meta={meta()}
        stacked={props.phone}
        caret={props.phone}
        laneWidth={runtimeLaneWidth}
        status={{
          label: uiText(reason() ? reasonText[reason()!] : "runtimeAvailable"),
          color: c()[reasonTone(reason())],
        }}
        onPress={() => {
          const next = !open();
          open.set(next);
          if (
            next &&
            !custom(props.runtime) &&
            props.runtime.status !== "missing"
          )
            props.listing.loadAccount(props.machine, props.runtime.id);
        }}
      />
      <If when={open()}>
        <RuntimeDetail
          listing={props.listing}
          machine={props.machine}
          runtime={props.runtime}
          weekTokens={props.weekTokens}
          phone={props.phone}
          onExternalAgent={props.onExternalAgent}
        />
      </If>
    </View>
  );
}

/** One machine's runtimes, or why they cannot be shown. */
function MachineRuntimes(props: {
  listing: RuntimeListing;
  machine: MachineView;
  usage: ReadonlyMap<string, ProviderUsage> | undefined;
  phone: boolean;
  onExternalAgent: (machineId: string, id: string) => void;
}) {
  const c = colors();
  const host = useHost();
  const runtimes = () => props.listing.runtimes(props.machine);
  const online = () => reachable(props.machine);
  const count = () => {
    const list = runtimes();
    return [
      props.machine.kind === "primary" ? uiText("externalAgentPrimary") : "",
      list
        ? uiText(list.length === 1 ? "runtimeOne" : "runtimeCount", {
            count: list.length,
          })
        : "",
    ]
      .filter(Boolean)
      .join(" · ");
  };
  const notice = (text: string) => (
    <View
      style={{
        ...row,
        gap: space[8],
        paddingHorizontal: space[16],
        paddingVertical: space[8],
        borderBottomWidth: 1,
        borderColor: c().border,
      }}
    >
      <StatusDot color={c().strong} />
      <Label variant="small" tone="muted" style={{ flex: 1, minWidth: 0 }}>
        {text}
      </Label>
    </View>
  );
  return (
    <>
      <SectionHeader
        title={props.machine.name}
        count={count() || undefined}
        muted={!online()}
        phone={props.phone}
      >
        <If when={online()}>
          <Button
            label={uiText("runtimesCheckAgain")}
            tone="ghost"
            size={props.phone ? control.md : control.sm}
            labelTone="mutedInk"
            icon="refresh"
            spinIcon
            iconSize={icon.sm}
            busy={props.listing.probing(props.machine)}
            style={{ paddingHorizontal: 0 }}
            onPress={() => void props.listing.refresh(props.machine)}
          />
        </If>
      </SectionHeader>
      <If when={props.listing.error(props.machine)}>
        {(error) => notice(problemText(error()))}
      </If>
      <If
        when={online()}
        else={notice(uiText("runtimesOffline", { name: props.machine.name }))}
      >
        <If
          when={runtimes()}
          else={
            <If
              when={runtimes() === null || !host.can("agents.runtimes")}
              else={notice(uiText("modelReadLoading"))}
            >
              {notice(
                host.can("agents.runtimes")
                  ? uiText("runtimesMachineUnreachable", {
                      name: props.machine.name,
                    })
                  : uiText("runtimesHostUnsupported"),
              )}
            </If>
          }
        >
          {(list) => (
            <>
              <If when={!list().length}>
                {notice(
                  uiText("runtimesNoneFound", { name: props.machine.name }),
                )}
              </If>
              <Each of={list()} key={(item) => item.id}>
                {(item) => (
                  <RuntimeRow
                    listing={props.listing}
                    machine={props.machine}
                    runtime={item()}
                    weekTokens={
                      props.usage?.get(item().id)?.windows["7d"].total
                    }
                    phone={props.phone}
                    onExternalAgent={props.onExternalAgent}
                  />
                )}
              </Each>
            </>
          )}
        </If>
      </If>
    </>
  );
}

/**
 * Settings › Runtimes: what each machine has to run an agent on, grouped by machine, the primary
 * first; a machine that is offline keeps its group and says so. Read only: signing a runtime in,
 * installing or upgrading it is done in a terminal on its machine.
 */
export function RuntimeList(props: {
  listing: RuntimeListing;
  phone: boolean;
  onExternalAgent: (machineId: string, id: string) => void;
}) {
  const host = useHost();
  follow(() => "usage");
  /** Each provider's usage; an external runtime's runs count under its id (`claude`, ...). */
  const usage = () => {
    const providers = host.section<readonly ProviderUsage[]>(
      "usage",
      "providers",
    );
    return providers === undefined
      ? undefined
      : new Map(providers.map((entry) => [entry.provider, entry]));
  };
  const machines = () => [
    ...props.listing.machines().filter(reachable),
    ...props.listing.machines().filter((machine) => !reachable(machine)),
  ];
  const load = useLoadState({ targets: () => ["machines"] });
  return (
    <>
      <If when={!machines().length}>
        <EmptyState
          size="page"
          width="narrow"
          style={emptyStyle}
          status={load.shown()}
          loading={<ListSkeleton label={uiText("loadingMachines")} />}
          error={{
            title: uiText("machinesDidNotLoad"),
            description: load.why(),
            retry: load.retry,
            retrying: load.retrying(),
          }}
          empty={{
            art: "machines",
            title: uiText("noMachinesYet"),
            description: uiText("noMachinesYetHint"),
          }}
        />
      </If>
      <Each of={machines()} key={(machine) => machine.id}>
        {(machine) => (
          <MachineRuntimes
            listing={props.listing}
            machine={machine()}
            usage={usage()}
            phone={props.phone}
            onExternalAgent={props.onExternalAgent}
          />
        )}
      </Each>
    </>
  );
}
