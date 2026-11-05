import type {
  DirectoryEntry,
  DirectoryProblem,
  ProjectArgs,
  ProjectResults,
} from "@eta/client-contracts";
import type { WireError } from "../../wire/wire";
import { computed, Scroll, signal, Text, untracked, View } from "nsh";
import { Input } from "nsh/base";
import { machineById, machines, projects } from "../../app/lists";
import { t } from "../../i18n";
import { Icon } from "../../ui/Icon";
import { Header, Page } from "../../ui/Page";
import { SelectSheet } from "../../ui/SelectSheet";
import { call } from "../../wire/target";
import { Caption, CheckBox, Cta } from "./fields";
import { shortenPath, usableMachines } from "./project";
import { loadRemembered, recentDirectories } from "./remember";

type Listing = ProjectResults["directories"];

/** The host says why in `problem.code`; its message reads `directory: <code>`. No word: nobody answered. */
function problemOf(error: unknown): DirectoryProblem {
  const failure = error as Partial<WireError>;
  const code = failure.problem?.code ?? /^directory: (\w+)$/.exec(failure.message ?? "")?.[1];
  return code === "not_found" || code === "denied" ? code : "offline";
}

const PROBLEM_TEXT = {
  not_found: "create.picker.notFound",
  denied: "create.picker.denied",
  offline: "create.picker.offline",
} as const;

/** The path as steps to press: from `~` inside the home, from `/` outside it. */
function crumbsOf(path: string, home: string | undefined) {
  const inside =
    home !== undefined && home !== "/" && (path === home || path.startsWith(`${home}/`));
  const root = inside ? home : "/";
  const crumbs = [{ name: inside ? "~" : "/", path: root }];
  let at = inside ? home : "";
  for (const name of path.slice(root.length).split("/")) {
    if (name === "") continue;
    at = `${at}/${name}`;
    crumbs.push({ name, path: at });
  }
  return crumbs;
}

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

const list = (machineId: string, path: string | undefined): Promise<Listing> =>
  call<Listing>("projects", "directories", {
    ...(machineId === "" ? {} : { machineId }),
    ...(path === undefined ? {} : { path }),
  } satisfies ProjectArgs["directories"]);

function Row(props: { name: string; tags: string[]; last?: boolean; onPress: () => void }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.name}
      onPress={props.onPress}
      class="h-12 shrink-0 flex-row items-center gap-[10px] border-t border-border px-4 active:bg-muted"
    >
      <Text class="min-w-0 grow basis-0 truncate text-base leading-[18px] text-foreground">
        {props.name}
      </Text>
      <Each of={props.tags} key="index">
        {(tag) => <Text class="shrink-0 text-sm leading-4 text-muted-foreground">{tag()}</Text>}
      </Each>
      <Icon name="caretRight" size={14} color="faint" />
    </View>
  );
}

/** 07a's list states, as 07a′ draws them. */
function Note(props: { text: string; muted?: boolean }) {
  return (
    <View class="border-t border-border px-4 py-[14px]">
      <Text
        class={`text-base leading-[22px] ${props.muted ? "text-muted-foreground" : "text-foreground"}`}
      >
        {props.text}
      </Text>
    </View>
  );
}

function Problem(props: { text: string; action?: string | undefined; onAction: () => void }) {
  return (
    <View class="flex-row items-center gap-3 border-y border-border px-4 py-[14px]">
      <Text class="min-w-0 grow basis-0 text-base leading-[22px] text-state-error">
        {props.text}
      </Text>
      <If when={props.action !== undefined}>
        <View
          role="button"
          accessibilityLabel={props.action}
          onPress={props.onAction}
          class="h-9 items-center justify-center border border-border-strong px-3 active:bg-muted"
        >
          <Text class="text-md leading-4 text-foreground">{props.action}</Text>
        </View>
      </If>
    </View>
  );
}

/**
 * 07a: walking to a directory on a machine. A press always goes in; what gets chosen is where you
 * are. A typed path is checked before the bar lets go of it.
 */
export function DirectoryPicker(props: {
  machineId: string;
  start: string | undefined;
  onPick: (path: string, machineId: string) => void;
}) {
  const place = signal({ machineId: props.machineId, path: props.start });
  const listing = signal<Listing | undefined>(undefined);
  const problem = signal<DirectoryProblem | undefined>(undefined);
  const filter = signal("");
  const showHidden = signal(false);
  const typing = signal<{ value: string; problem?: DirectoryProblem } | undefined>(undefined);
  const pickingMachine = signal(false);
  // Only the newest question counts: an answer left behind says nothing.
  let attempt = 0;
  let typedAttempt = 0;

  const load = async () => {
    attempt += 1;
    const mine = attempt;
    const { machineId, path } = untracked(() => place());
    listing.set(undefined);
    problem.set(undefined);
    try {
      const found = await list(machineId, path);
      if (mine === attempt) listing.set(found);
    } catch (error) {
      if (mine === attempt) problem.set(problemOf(error));
    }
  };

  const go = (next: { machineId?: string; path: string | undefined }) => {
    typedAttempt += 1;
    place.set({ ...untracked(() => place()), ...next });
    filter.set("");
    typing.set(undefined);
    void load();
  };

  const jump = async () => {
    const value = untracked(() => typing())?.value.trim();
    if (value === undefined || value === "") return;
    typedAttempt += 1;
    const mine = typedAttempt;
    try {
      const found = await list(untracked(() => place()).machineId, value);
      if (mine !== typedAttempt) return;
      attempt += 1;
      place.set({ ...untracked(() => place()), path: found.path });
      filter.set("");
      typing.set(undefined);
      problem.set(undefined);
      listing.set(found);
    } catch (error) {
      if (mine === typedAttempt) typing.set({ value, problem: problemOf(error) });
    }
  };

  void loadRemembered();
  void load();

  const machine = () => machineById(place().machineId);
  const home = () => listing()?.home ?? machine()?.home ?? undefined;
  const current = () => listing()?.path ?? place().path ?? home();
  const up = () => {
    const path = current();
    return path === undefined || path === "/" ? undefined : parentOf(path);
  };
  const needle = () => filter().trim().toLowerCase();
  const entries = computed(() =>
    (listing()?.entries ?? []).filter(
      (entry: DirectoryEntry) =>
        (showHidden() || !entry.hidden) && entry.name.toLowerCase().includes(needle()),
    ),
  );
  const recents = computed(() => {
    const listed = listing();
    if (listed === undefined || listed.path !== listed.home || needle() !== "") return [];
    return (recentDirectories()[place().machineId] ?? []).filter((path) => path !== listed.path);
  });
  const added = (path: string) =>
    projects().some((each) => each.machineId === place().machineId && each.path === path);
  const empty = () => entries().length === 0 && recents().length === 0;
  const crumbs = () => crumbsOf(current() ?? "/", home());

  return (
    <Page>
      <Header title={t("create.picker.title")} border={false} />
      <If when={usableMachines().length > 1}>
        <View
          role="button"
          accessibilityLabel={t("create.picker.machine")}
          testID="picker-machine"
          onPress={() => pickingMachine.set(true)}
          class="h-12 shrink-0 flex-row items-center gap-3 border-t border-border px-4 active:bg-muted"
        >
          <Text class="w-[32px] shrink-0 text-sm leading-4 text-muted-foreground">
            {t("create.picker.machine")}
          </Text>
          <Text class="grow basis-0 text-base leading-[18px] text-foreground">
            {machine()?.name ?? ""}
          </Text>
          <Icon name="caretRight" size={14} color="faint" />
        </View>
      </If>
      <View
        class={`h-11 shrink-0 flex-row items-center gap-[6px] border-t bg-surface px-4 ${typing()?.problem === undefined ? "border-border" : "border-state-error"}`}
      >
        <If
          when={typing() !== undefined}
          else={
            // Pinned to the end: a long path gives up its start, the part that matters least.
            <View class="min-w-0 grow basis-0 flex-row items-center justify-end gap-[6px] overflow-hidden">
              <Each of={crumbs()} key={(crumb) => crumb.path}>
                {(crumb, index) => (
                  <>
                    <If when={index() > 0 && crumbs()[index() - 1]?.name !== "/"}>
                      <Text class="shrink-0 text-md leading-4 text-faint">/</Text>
                    </If>
                    <Text
                      role="button"
                      onPress={() => go({ path: crumb().path })}
                      class={`shrink-0 text-md leading-4 active:opacity-60 ${index() === crumbs().length - 1 ? "text-foreground" : "text-muted-foreground"}`}
                    >
                      {crumb().name}
                    </Text>
                  </>
                )}
              </Each>
            </View>
          }
        >
          <Input
            testID="picker-path"
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            value={typing()?.value ?? ""}
            onChange={({ value }) => typing.set({ value })}
            onSubmit={() => void jump()}
            placeholder={t("create.picker.pathPlaceholder")}
            class="min-w-0 grow basis-0 text-md text-foreground placeholder:text-faint"
          />
        </If>
        <Text
          role="button"
          hitSlop={12}
          onPress={() => {
            if (typing() === undefined) typing.set({ value: current() ?? "" });
            else {
              typedAttempt += 1;
              typing.set(undefined);
            }
          }}
          class="shrink-0 text-sm leading-4 text-muted-foreground active:opacity-60"
        >
          {typing() === undefined ? t("create.picker.typePath") : t("common.cancel")}
        </Text>
      </View>
      <If when={typing()?.problem !== undefined}>
        <View class="shrink-0 px-4 py-[6px]">
          <Text class="text-sm leading-[18px] text-state-error">
            {t(PROBLEM_TEXT[typing()?.problem ?? "offline"])}
          </Text>
        </View>
      </If>
      <View class="h-12 shrink-0 flex-row items-center gap-3 border-y border-border px-4">
        <Input
          testID="picker-filter"
          autoCapitalize="none"
          autoCorrect={false}
          value={filter()}
          onChange={({ value }) => filter.set(value)}
          placeholder={t("create.picker.filter")}
          class="min-w-0 grow basis-0 text-input text-foreground placeholder:text-faint"
        />
        <View
          role="checkbox"
          accessibilityLabel={t("create.picker.hidden")}
          onPress={() => showHidden.set(!showHidden())}
          class="flex-row items-center gap-[6px] active:opacity-60"
        >
          <CheckBox checked={showHidden()} size={16} />
          <Text class="text-sm leading-4 text-muted-foreground">{t("create.picker.hidden")}</Text>
        </View>
      </View>
      <Scroll style={{ flex: 1 }} keyboardDismissMode="interactive">
        <If when={listing() !== undefined}>
          <If
            when={!empty()}
            else={<Note text={needle() === "" ? t("create.picker.empty") : t("create.picker.noMatch")} />}
          >
            <If when={recents().length > 0}>
              <Caption title={t("create.picker.recent")} height={30} />
              <Each of={recents()}>
                {(path) => (
                  <Row
                    name={shortenPath(path(), listing()?.home)}
                    tags={added(path()) ? [t("create.picker.added")] : []}
                    onPress={() => go({ path: path() })}
                  />
                )}
              </Each>
              <View class="border-t border-border">
                <Caption title={t("create.picker.home")} height={36} />
              </View>
            </If>
            <Each of={entries()} key={(entry) => entry.name}>
              {(entry) => (
                <Row
                  name={entry().name}
                  tags={[
                    ...(entry().git ? ["git"] : []),
                    ...(entry().projectId === null ? [] : [t("create.picker.added")]),
                  ]}
                  onPress={() => {
                    const base = listing()?.path ?? "";
                    go({ path: `${base === "/" ? "" : base}/${entry().name}` });
                  }}
                />
              )}
            </Each>
            <View class="border-t border-border" />
            <If when={listing()?.truncated === true}>
              <Note
                muted
                text={t("create.picker.truncated", { limit: listing()?.entries.length ?? 0 })}
              />
            </If>
          </If>
        </If>
        <If when={problem() !== undefined}>
          <Problem
            text={t(PROBLEM_TEXT[problem() ?? "offline"])}
            action={
              problem() === "offline"
                ? t("common.retry")
                : up() === undefined
                  ? undefined
                  : t("create.picker.up")
            }
            onAction={() => {
              if (problem() === "offline") void load();
              else go({ path: up() });
            }}
          />
        </If>
      </Scroll>
      <Cta
        title={t("create.picker.choose")}
        testID="picker-choose"
        disabled={listing() === undefined || typing() !== undefined}
        onPress={() => {
          const listed = listing();
          if (listed !== undefined) props.onPick(listed.path, place().machineId);
        }}
      />
      <SelectSheet
        open={pickingMachine()}
        title={t("create.picker.machine")}
        value={place().machineId}
        options={machines()
          .filter((each) => each.status === "online" || each.status === "offline")
          .map((each) => ({
            value: each.id,
            label: each.name,
            disabled: each.status !== "online",
          }))}
        onChange={(machineId) => go({ machineId, path: undefined })}
        onClose={() => pickingMachine.set(false)}
      />
    </Page>
  );
}
