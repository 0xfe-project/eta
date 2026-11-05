import type { MachineView } from "@eta/client-contracts";
import type { SettingsTab } from "../../nav/links";
import { signal, Text, View } from "nsh";
import { machineById, machines } from "../../app/lists";
import { scheme, setScheme } from "../../app/prefs";
import { host, wire } from "../../app/session";
import { language, setLanguage, t } from "../../i18n";
import { go } from "../../nav/links";
import { Button } from "../../ui/Button";
import { Body, Header, Page } from "../../ui/Page";
import { Segmented } from "../../ui/Segmented";
import { Empty } from "../../ui/States";
import { leaveHost } from "../connect";
import { RunRow, useRuns } from "../inbox/running";
import { hostVersion } from "./version";

const OS_LABELS: Record<string, string> = { darwin: "macOS", linux: "Linux", windows: "Windows" };
/** Past this many slots a meter says more than it shows: the numbers beside it are enough. */
const MAX_METER = 8;

const primary = (): MachineView | undefined =>
  machines().find((machine) => machine.kind === "primary");

function Title(props: { text: string; class: string }) {
  return (
    <View class={`shrink-0 px-4 ${props.class}`}>
      <Text class="h-[34px] truncate text-gauge-sm leading-[34px] tracking-[-0.02em] text-foreground">
        {props.text}
      </Text>
    </View>
  );
}

function Option(props: { title: string; on: boolean; onPress: () => void }) {
  return <Button title={props.title} variant={props.on ? "primary" : "outline"} onPress={props.onPress} />;
}

/** 10. */
function Appearance() {
  return (
    <View class="gap-[20px] px-4 pt-4">
      <View class="gap-2">
        <Text class="text-sm leading-[18px] text-muted-foreground">{t("settings.scheme")}</Text>
        <View class="flex-row gap-2">
          <Option
            title={t("settings.scheme.system")}
            on={scheme() === "system"}
            onPress={() => setScheme("system")}
          />
          <Option
            title={t("settings.scheme.light")}
            on={scheme() === "light"}
            onPress={() => setScheme("light")}
          />
          <Option
            title={t("settings.scheme.dark")}
            on={scheme() === "dark"}
            onPress={() => setScheme("dark")}
          />
        </View>
      </View>
      <View class="gap-2">
        <Text class="text-sm leading-[18px] text-muted-foreground">{t("settings.language")}</Text>
        <View class="flex-row gap-2">
          <Option title="简体中文" on={language() === "zh"} onPress={() => setLanguage("zh")} />
          <Option title="English" on={language() === "en"} onPress={() => setLanguage("en")} />
        </View>
      </View>
    </View>
  );
}

function versionText(machine: MachineView, hostBuild: string | undefined): string | undefined {
  return machine.kind === "primary" ? hostBuild : (machine.version ?? undefined);
}

function buildNote(machine: MachineView): string | undefined {
  if (machine.build === "outdated") return t("settings.outdated");
  if (machine.build === "updating") return t("settings.updating");
  return undefined;
}

function lastOnline(at: number | null): string | undefined {
  if (at === null) return undefined;
  const minutes = Math.floor((Date.now() - at) / 60_000);
  const ago = (when: string) => t("settings.lastOnline", { when: t("settings.ago", { when }) });
  if (minutes < 60) return ago(t("common.minutesAgo", { count: Math.max(minutes, 1) }));
  if (minutes < 24 * 60) return ago(t("common.hoursAgo", { count: Math.floor(minutes / 60) }));
  const date = new Date(at);
  return t("settings.lastOnline", { when: `${date.getMonth() + 1}/${date.getDate()}` });
}

function Meter(props: { used: number; slots: number }) {
  return (
    <If when={props.slots <= MAX_METER}>
      <View class="flex-row gap-[3px]">
        <Each of={Array.from({ length: props.slots }, (_, slot) => slot)}>
          {(slot) => (
            <View class={`h-[18px] w-[10px] shrink-0 ${slot() < props.used ? "bg-foreground" : "bg-border"}`} />
          )}
        </Each>
      </View>
    </If>
  );
}

function MachineRow(props: {
  machine: MachineView;
  used: number;
  waiting: number;
  build: string | undefined;
  last: boolean;
}) {
  const offline = () => props.machine.status === "offline";
  const online = () => props.machine.status === "online";
  const line = () => {
    const { machine } = props;
    if (machine.status === "pending") return t("settings.pending");
    if (offline()) {
      return [
        t("settings.offline"),
        lastOnline(machine.lastSeenAt),
        props.waiting > 0 ? t("settings.tasksWaiting", { count: props.waiting }) : undefined,
      ]
        .filter((part) => part !== undefined)
        .join(" · ");
    }
    const version = versionText(machine, props.build);
    return [
      machine.kind === "primary" ? t("settings.primary") : undefined,
      version === undefined ? undefined : t("settings.version", { version }),
      buildNote(machine),
      machine.kind === "primary" ? t("settings.thisPhone") : undefined,
    ]
      .filter((part) => part !== undefined)
      .join(" · ");
  };
  return (
    <View
      role="button"
      accessibilityLabel={props.machine.name}
      onPress={() => go.machine(props.machine.id)}
      class={`h-[60px] shrink-0 flex-row items-center gap-3 border-t border-border px-4 active:bg-muted ${props.last ? "border-b" : ""}`}
    >
      <View class="min-w-0 grow basis-0">
        <Text class={`truncate text-lead leading-[22px] ${offline() ? "text-muted-foreground" : "text-foreground"}`}>
          {props.machine.name}
        </Text>
        <Text class={`truncate text-sm leading-4 ${offline() ? "text-state-error" : "text-muted-foreground"}`}>
          {line()}
        </Text>
      </View>
      <If when={online()}>
        <Meter used={props.used} slots={props.machine.maxActiveRuns} />
        <Text class="min-w-[28px] shrink-0 text-right text-md leading-4 text-foreground">
          {`${props.used}/${props.machine.maxActiveRuns}`}
        </Text>
      </If>
    </View>
  );
}

/** 10b: look, don't touch. Machines are managed on the computer. */
function Machines(props: { build: string | undefined }) {
  const { running, queued } = useRuns();
  const shown = () => machines().filter((machine) => machine.status !== "revoked");
  const taskRuns = () => running().filter((run) => run.task);
  return (
    <View>
      <View class="h-[34px] shrink-0 flex-row items-end justify-between px-4 pb-[6px]">
        <Text class="text-sm leading-[18px] text-muted-foreground">{t("settings.machines")}</Text>
        <Text class="text-sm leading-[18px] text-muted-foreground">
          {t("settings.runs", { count: taskRuns().length })}
        </Text>
      </View>
      <Each of={shown()} key={(machine) => machine.id}>
        {(machine, index) => (
          <MachineRow
            machine={machine()}
            used={taskRuns().filter((run) => run.machineId === machine().id).length}
            waiting={queued().filter((run) => run.machineId === machine().id).length}
            build={props.build}
            last={index() === shown().length - 1}
          />
        )}
      </Each>
    </View>
  );
}

function InfoRow(props: { label: string; value: string; last?: boolean }) {
  return (
    <View
      class={`h-12 shrink-0 flex-row items-center justify-between gap-4 border-t border-border px-4 ${props.last ? "border-b" : ""}`}
    >
      <Text class="shrink-0 text-base leading-[18px] text-muted-foreground">{props.label}</Text>
      <Text class="min-w-0 truncate text-base leading-[18px] text-foreground">{props.value}</Text>
    </View>
  );
}

/** 10c. */
function Connection(props: { build: string | undefined }) {
  return (
    <View class="pt-2">
      <InfoRow
        label={t("settings.status")}
        value={wire().status() === "open" ? t("settings.connected") : t("settings.reconnecting")}
      />
      <InfoRow label={t("settings.host")} value={primary()?.name ?? t("settings.unknown")} />
      <InfoRow label={t("settings.address")} value={host()?.address ?? t("settings.unknown")} />
      <InfoRow label={t("settings.versionLabel")} value={props.build ?? t("settings.unknown")} last />
      <View class="gap-[10px] px-4 pt-[24px]">
        <View class="flex-row">
          <Button title={t("settings.disconnect")} height={44} onPress={leaveHost} />
        </View>
        <Text class="text-sm leading-[18px] text-muted-foreground">{t("settings.stillRunning")}</Text>
      </View>
    </View>
  );
}

export function SettingsScreen(props: { tab: SettingsTab }) {
  const tab = signal<SettingsTab>(props.tab);
  const build = useBuild();
  return (
    <Page>
      <Header border={false} />
      <Title text={t("settings.title")} class="pb-3" />
      <View class="shrink-0 px-4 pb-2">
        <Segmented
          value={tab()}
          onChange={(next) => tab.set(next)}
          options={[
            { value: "appearance", label: t("settings.tab.appearance") },
            { value: "machines", label: t("settings.tab.machines") },
            { value: "connection", label: t("settings.tab.connection") },
          ]}
        />
      </View>
      <Body>
        <If when={tab() === "appearance"}>
          <Appearance />
        </If>
        <If when={tab() === "machines"}>
          <Machines build={build()} />
        </If>
        <If when={tab() === "connection"}>
          <Connection build={build()} />
        </If>
      </Body>
    </Page>
  );
}

/** What the host says of itself over HTTP; a daemon's own build is in its row. */
function useBuild() {
  const build = signal<string | undefined>(undefined);
  const target = host();
  if (target !== undefined) void hostVersion(target).then((version) => build.set(version));
  return build;
}

/** 10a. */
export function MachineScreen(props: { id: string }) {
  const { running } = useRuns();
  const build = useBuild();
  const machine = () => machineById(props.id);
  const runs = () => running().filter((run) => run.machineId === props.id);
  const used = () => runs().filter((run) => run.task).length;
  const statusText = (status: MachineView["status"]) => {
    if (status === "online") return t("settings.online");
    if (status === "offline") return t("settings.offline");
    return t("settings.pending");
  };
  const version = (shown: MachineView) => {
    const text = versionText(shown, build());
    if (text === undefined) return t("settings.unknown");
    const note = buildNote(shown);
    return note === undefined ? text : `${text} · ${note}`;
  };
  return (
    <Page>
      <Header border={false} />
      <If
        when={machine() !== undefined}
        else={<Empty title={t("settings.machineGone")} />}
      >
        <Title text={machine()?.name ?? ""} class="pb-4" />
        <Body>
          <InfoRow label={t("settings.status")} value={statusText(machine()?.status ?? "pending")} />
          <InfoRow
            label={t("settings.system")}
            value={OS_LABELS[machine()?.os ?? ""] ?? machine()?.os ?? t("settings.unknown")}
          />
          <If when={machine() !== undefined}>
            <InfoRow
              label={t("settings.versionLabel")}
              value={version(machine() as MachineView)}
            />
          </If>
          <InfoRow
            label={t("settings.concurrent")}
            value={`${used()} / ${machine()?.maxActiveRuns ?? 0}`}
            last={runs().length === 0}
          />
          <If when={runs().length > 0}>
            <View class="h-[42px] shrink-0 flex-row items-end border-t border-border px-4 pb-[6px]">
              <Text class="text-sm leading-[18px] text-muted-foreground">
                {t("settings.running", { count: runs().length })}
              </Text>
            </View>
            <Each of={runs()} key={(run) => run.key}>
              {(run, index) => <RunRow run={run()} plain last={index() === runs().length - 1} />}
            </Each>
          </If>
        </Body>
      </If>
    </Page>
  );
}
