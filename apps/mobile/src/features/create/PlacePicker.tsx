import type { CloneView, RecentPlace } from "@eta/client-contracts";
import type { PlaceChoice } from "./place-flow";
import { Scroll, Text, View } from "nsh";
import { Input } from "nsh/base";
import { machineById } from "../../app/lists";
import { t } from "../../i18n";
import { nav } from "../../nav/stack";
import { Icon } from "../../ui/Icon";
import { Header, Page } from "../../ui/Page";
import { useTarget } from "../../wire/target";
import { Caption, CheckBox, Cta } from "./fields";
import { createPlaceFlow, PLACEHOLDER_KEYS, problemKey } from "./place-flow";

const NO_RECENT: RecentPlace[] = [];
const NO_CLONES: CloneView[] = [];

function Row(props: {
  label: string;
  detail?: string | undefined;
  tags: string[];
  disabled: boolean;
  goes: boolean;
  onPress: () => void;
}) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={() => {
        if (!props.disabled) props.onPress();
      }}
      class={`min-h-12 shrink-0 flex-row items-center gap-[10px] border-t border-border px-4 py-2 ${props.disabled ? "" : "active:bg-muted"}`}
    >
      <View class="min-w-0 grow basis-0">
        <Text
          class={`truncate text-base leading-[18px] ${props.disabled ? "text-faint" : "text-foreground"}`}
        >
          {props.label}
        </Text>
        <If when={props.detail !== undefined}>
          <Text class="truncate text-sm leading-4 text-muted-foreground">
            {props.detail}
          </Text>
        </If>
      </View>
      <Each of={props.tags} key="index">
        {(tag) => (
          <Text class="shrink-0 text-sm leading-4 text-muted-foreground">
            {tag()}
          </Text>
        )}
      </Each>
      <If when={props.goes && !props.disabled}>
        <Icon name="caretRight" size={14} color="faint" />
      </If>
    </View>
  );
}

/**
 * 07a: choosing a directory on a machine, a page of the shared flow at a time: the machine, the
 * way (search, browse, clone from GitHub, new directory), that way's page, and where a clone or a
 * new directory goes. The back arrow is one page back; on the first page it leaves.
 */
export function PlacePicker(props: {
  machineId?: string | undefined;
  onPick: (choice: PlaceChoice) => void;
}) {
  const places = useTarget("places");
  const flow = createPlaceFlow({
    machineId: props.machineId,
    recent: () => places.section<RecentPlace[]>("recent") ?? NO_RECENT,
    clones: () => places.section<CloneView[]>("clones") ?? NO_CLONES,
    onChoose: props.onPick,
  });
  const page = flow.page;
  const machineName = () => {
    const id = flow.machineId();
    return id === undefined ? undefined : machineById(id)?.name;
  };
  const title = () => {
    const at = page();
    switch (at.kind) {
      case "machine":
        return t("create.picker.machine");
      case "method":
        return t("create.picker.title");
      case "search":
        return t("create.places.way.search");
      case "browse":
        return t("create.places.way.browse");
      case "github":
        return t("create.places.way.github");
      case "clone-location":
        return t("create.places.cloneTo", { repo: at.repo.nameWithOwner });
      case "new-parent":
        return t("create.places.way.new");
      case "new-name":
        return t("create.places.newIn", { path: at.parent.display });
    }
  };
  const placeholder = () => t(PLACEHOLDER_KEYS[page().kind]);

  return (
    <Page form>
      <Header
        title={title()}
        {...(machineName() === undefined ? {} : { subtitle: machineName() })}
        border={false}
        onBack={() => {
          if (!flow.back()) nav.pop();
        }}
      />
      <If when={page().kind !== "method"}>
        <View class="h-12 shrink-0 flex-row items-center gap-3 border-y border-border bg-surface px-4">
          <Input
            testID="place-query"
            autoCapitalize="none"
            autoCorrect={false}
            value={page().query}
            onChange={({ value }) => flow.type(value)}
            onSubmit={() => {
              const first = flow.rows().find((row) => !row.disabled);
              if (first !== undefined && !page().busy) first.take();
            }}
            placeholder={placeholder()}
            class="min-w-0 grow basis-0 text-input text-foreground placeholder:text-faint"
          />
          <If when={page().kind === "browse"}>
            <View
              role="checkbox"
              accessibilityLabel={t("create.picker.hidden")}
              onPress={() => {
                const at = page();
                if (at.kind === "browse") flow.showHidden(!at.showHidden);
              }}
              class="flex-row items-center gap-[6px] active:opacity-60"
            >
              <CheckBox
                checked={(() => {
                  const at = page();
                  return at.kind === "browse" && at.showHidden;
                })()}
                size={16}
              />
              <Text class="text-sm leading-4 text-muted-foreground">
                {t("create.picker.hidden")}
              </Text>
            </View>
          </If>
        </View>
      </If>
      <If when={flow.crumbs() !== undefined}>
        <View class="h-10 shrink-0 flex-row items-center gap-[6px] overflow-hidden border-b border-border px-4">
          <Each of={flow.crumbs() ?? []} key={(crumb) => crumb.path}>
            {(crumb, index) => (
              <>
                <If when={index() > 0}>
                  <Text class="shrink-0 text-md leading-4 text-faint">
                    {flow.flavor() === "win32" ? "\\" : "/"}
                  </Text>
                </If>
                <Text
                  role="button"
                  onPress={() => flow.walk(crumb().path)}
                  class={`shrink-0 text-md leading-4 active:opacity-60 ${index() === (flow.crumbs()?.length ?? 0) - 1 ? "text-foreground" : "text-muted-foreground"}`}
                >
                  {crumb().name}
                </Text>
              </>
            )}
          </Each>
        </View>
      </If>
      <If when={flow.problem() !== null}>
        <View class="flex-row items-center gap-3 border-b border-border px-4 py-[12px]">
          <Text class="min-w-0 grow basis-0 text-base leading-[22px] text-state-error">
            {t(problemKey(flow.problem()?.code ?? "other"), {
              detail: flow.problem()?.detail ?? "",
            })}
          </Text>
          <If
            when={
              flow.problem()?.code === "offline" ||
              flow.problem()?.code === "timeout"
            }
          >
            <View
              role="button"
              accessibilityLabel={t("common.retry")}
              onPress={flow.retry}
              class="h-9 items-center justify-center border border-border-strong px-3 active:bg-muted"
            >
              <Text class="text-md leading-4 text-foreground">
                {t("common.retry")}
              </Text>
            </View>
          </If>
        </View>
      </If>
      <If when={flow.clone() !== undefined}>
        <View class="border-b border-border px-4 py-[10px]">
          <Text class="text-sm leading-4 text-foreground">
            {t("create.places.cloning", {
              path: flow.clone()?.target.display ?? "",
              progress:
                flow.clone()?.progress === null ||
                flow.clone()?.progress === undefined
                  ? ""
                  : `${flow.clone()?.progress?.phase ?? ""} ${flow.clone()?.progress?.percent ?? ""}%`,
            })}
          </Text>
        </View>
      </If>
      <Scroll
        style={{ flex: 1 }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
      >
        <Each of={flow.rows()} key={(row) => row.key}>
          {(row, index) => (
            <>
              <If
                when={
                  row().section !== undefined &&
                  row().section !== flow.rows()[index() - 1]?.section
                }
              >
                <Caption title={row().section ?? ""} height={30} />
              </If>
              <Row
                label={row().label}
                detail={row().detail}
                tags={row().tags}
                disabled={row().disabled}
                goes={row().goes}
                onPress={() => {
                  if (!page().busy) row().take();
                }}
              />
            </>
          )}
        </Each>
        <If when={flow.rows().length === 0}>
          <View class="border-t border-border px-4 py-[14px]">
            <Text class="text-base leading-[22px] text-muted-foreground">
              {t(
                page().kind === "github"
                  ? "create.places.empty.github"
                  : page().kind === "new-name"
                    ? "create.places.empty.newName"
                    : page().kind === "browse"
                      ? "create.picker.empty"
                      : page().query.trim() === ""
                        ? "create.places.empty.search"
                        : "create.picker.noMatch",
              )}
            </Text>
          </View>
        </If>
        <View class="border-t border-border" />
      </Scroll>
      <If when={page().kind === "browse"}>
        <Cta
          title={t("create.picker.choose")}
          testID="picker-choose"
          disabled={flow.listing() === undefined || page().busy}
          onPress={flow.useHere}
        />
      </If>
    </Page>
  );
}
