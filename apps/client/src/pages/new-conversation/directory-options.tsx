import type { FlowPage } from "@eta/client-contracts";
import type { Layout } from "../../components";
import type { usePlaceFlow } from "./use-place-flow";
import {
  moveActive,
  openBrowse,
  pageKey,
  setActive,
  setQuery,
  setShowHidden,
} from "@eta/client-contracts";
import { cleanup, effect, keymap, signal, View } from "nsh";
import { Input } from "nsh/base";
import {
  Button,
  colors,
  focusRing,
  grow,
  Icon,
  Label,
  ListSkeleton,
  row,
  textFaces,
} from "../../components";
import { EmptyState } from "../../components/empty-state";
import { shownWhile } from "../../components/pending";
import { Spinner } from "../../components/spinner";
import { control, icon, opacity, space } from "../../components/tokens";
import { localizedText, uiText } from "../../i18n";
import { useHost } from "../../services/host";

/** A place to choose: a finger's row on phones, a list row elsewhere. */
const optionRowHeight = { phone: 56, desktop: 28 } as const;

export function DirectoryOptions(props: {
  picker: ReturnType<typeof usePlaceFlow>;
  title: string;
  layout: Layout;
}) {
  const host = useHost();
  const phone = () => props.layout === "phone";
  const c = colors();
  const type = textFaces();
  const {
    flow,
    busy,
    clone,
    selected,
    options,
    select,
    rows,
    kind,
    page,
    error,
    machineName,
    listing,
    machineId,
    query,
    loading,
    cloneProgress,
    cancelling,
    cancelClone,
  } = props.picker;
  const refreshingShown = shownWhile(
    () => (loading() || busy()) && rows().length > 0,
  );
  const cloneSlow = signal(false);
  effect(() => {
    const active = cloneProgress();
    // Reset the 10s slow timer whenever a clone starts, ends, or advances stage/percent.
    const stageKey = active
      ? `${active.id}:${active.progress?.phase ?? ""}:${active.progress?.percent ?? ""}`
      : "";
    cloneSlow.set(false);
    if (!stageKey) return;
    const timer = setTimeout(() => cloneSlow.set(true), 10_000);
    cleanup(() => clearTimeout(timer));
  });
  const placeholder = () => {
    switch (kind()) {
      case "machine":
        return localizedText("Search machines", "搜索机器");
      case "browse":
        return localizedText("Filter directories", "筛选目录");
      case "github":
        return localizedText(
          "Search repositories or paste a URL",
          "搜索仓库或粘贴 URL",
        );
      case "clone-location":
      case "new-parent":
        return localizedText(
          "Search for a parent directory or enter a path",
          "搜索上级目录或输入路径",
        );
      case "new-name":
        return localizedText("Name the directory", "输入目录名称");
      default:
        return localizedText(
          "Search directories or enter a path",
          "搜索目录或输入路径",
        );
    }
  };

  const waiting = () =>
    localizedText("Waiting for the machine…", "正在等待机器响应…");
  /** What an empty step says: what it lists, and the search that found none. */
  const nothing = () => {
    const words = query().trim();
    if (kind() === "machine")
      return words
        ? localizedText(
            `No machines match “${words}”`,
            `没有匹配「${words}」的机器`,
          )
        : localizedText("No machines yet", "还没有机器");
    if (kind() === "browse")
      return words
        ? localizedText(
            `No folders match “${words}”`,
            `没有匹配「${words}」的目录`,
          )
        : localizedText("No folders in here", "这个目录里没有子目录");
    return words
      ? localizedText(
          `No directories match “${words}”`,
          `没有匹配「${words}」的目录`,
        )
      : localizedText(
          "No recent places yet. Search, or enter a path.",
          "还没有最近用过的位置。搜索或输入路径。",
        );
  };
  // The bindings leave with these rows, so Enter can edit the conversation name on the members step.
  const move = (direction: "next" | "previous") => {
    if (!busy() && !clone())
      flow.update((state) =>
        moveActive(setActive(state, selected()), options(), direction),
      );
  };
  keymap.bind(
    { down: () => move("next"), up: () => move("previous") },
    { when: "always", repeat: true },
  );
  keymap.bind("enter", () => select(rows()[selected()]), { when: "always" });
  return (
    <>
      <If when={kind() !== "method"}>
        <View
          style={{
            ...row,
            marginHorizontal: space[16],
            marginTop: space[16],
            marginBottom: space[8],
            paddingLeft: space[12],
            borderWidth: 1,
            borderColor: c().ink,
          }}
        >
          <Icon name="search" size={icon.md} />
          <Each of={[pageKey(page())]}>
            {() => (
              <Input
                accessibilityLabel={props.title}
                value={page().query}
                placeholder={placeholder()}
                autoFocus={!phone()}
                submitBehavior="submit"
                onSubmit={() => select(rows()[selected()])}
                onChange={({ value }) => {
                  error.set(undefined);
                  flow.update((state) => setQuery(state, value));
                }}
                style={{
                  ...grow,
                  height: phone() ? control.touch : control.lg,
                  paddingHorizontal: space[8],
                  color: c().ink,
                  placeholderColor: c().muted,
                  fontSize: type("body").size,
                }}
              />
            )}
          </Each>
          <If when={refreshingShown()}>
            <View style={{ paddingRight: space[8] }}>
              <Spinner size={icon.sm} tone="muted" />
            </View>
          </If>
        </View>
      </If>
      <If when={kind() === "method"}>
        <View
          style={{
            ...row,
            gap: space[8],
            minHeight: phone() ? space[32] : space[24],
            marginTop: phone() ? space[12] : 0,
            paddingHorizontal: space[16],
            borderBottomWidth: phone() ? 0 : 1,
            borderColor: c().border,
          }}
        >
          <If when={phone()}>
            <Icon name="monitor" size={icon.md} />
          </If>
          <Label variant="small">{machineName()}</Label>
        </View>
        <If
          when={!phone()}
          else={
            <Label
              tone="muted"
              style={{
                paddingHorizontal: space[16],
                paddingTop: space[4],
                paddingBottom: space[8],
              }}
            >
              {localizedText(
                "How do you want to add it?",
                "你想怎样添加目录？",
              )}
            </Label>
          }
        >
          <View
            style={{
              height: space[40],
              justifyContent: "center",
              paddingHorizontal: space[16],
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <Label tone="muted">
              {localizedText(
                "How do you want to add it?",
                "你想怎样添加目录？",
              )}
            </Label>
          </View>
        </If>
      </If>
      <If when={kind() === "browse" && listing()}>
        <View
          style={{
            ...row,
            paddingHorizontal: space[16],
            gap: space[4],
            flexWrap: "wrap",
          }}
        >
          <Each of={listing()?.crumbs ?? []} key={(crumb) => crumb.path}>
            {(crumb) => (
              <Button
                label={crumb().name}
                tone="ghost"
                onPress={() =>
                  flow.update((state) =>
                    openBrowse(state, machineId()!, crumb().path),
                  )
                }
              />
            )}
          </Each>
          <Button
            label={localizedText("Hidden folders", "隐藏文件夹")}
            selected={
              (page() as Extract<FlowPage, { kind: "browse" }>).showHidden
            }
            onPress={() => {
              const current = page();
              if (current.kind === "browse")
                flow.update((state) =>
                  setShowHidden(state, !current.showHidden),
                );
            }}
          />
        </View>
      </If>
      <If
        when={kind() === "search" && query() && !loading() && rows().length > 0}
      >
        <Label
          tracking="caps"
          variant="caption"
          tone="muted"
          style={{
            paddingHorizontal: space[16],
            // 16pt below the field, whose own margin gives the first 8.
            paddingTop: space[8],
            paddingBottom: space[8],
            borderBottomWidth: phone() ? 0 : 1,
            borderColor: c().border,
          }}
        >
          {localizedText(
            `${rows().length} ${rows().length === 1 ? "MATCH" : "MATCHES"} ON ${machineName().toUpperCase()}`,
            `${machineName()} 上的 ${rows().length} 个匹配项`,
          )}
        </Label>
      </If>
      <Each of={rows()} key={(entry) => entry.id}>
        {(entry, index) => (
          <View
            role="button"
            accessibilityLabel={entry().label}
            accessibilityState={{
              disabled: !!entry().disabled || busy() || !!clone(),
              selected: selected() === index(),
            }}
            onPress={() => select(entry())}
            focusVisibleStyle={focusRing(c(), "inset")}
            hoverStyle={{ backgroundColor: c().selected }}
            style={{
              ...row,
              minHeight: phone()
                ? optionRowHeight.phone
                : optionRowHeight.desktop,
              marginHorizontal: phone() ? space[16] : 0,
              paddingHorizontal: phone() ? space[4] : space[16],
              gap: phone() ? space[12] : space[8],
              borderTopWidth: phone() && index() === 0 ? 1 : 0,
              borderBottomWidth: phone() ? 1 : 0,
              borderColor: c().border,
              backgroundColor:
                selected() === index() ? c().selected : c().canvas,
              cursor: entry().disabled ? "default" : "pointer",
              opacity: entry().disabled ? opacity.disabled : 1,
            }}
          >
            <If when={phone()}>
              <Icon name={entry().icon} size={icon.md} />
            </If>
            <View
              style={{
                ...grow,
                flexDirection: phone() ? "column" : "row",
                alignItems: phone() ? "stretch" : "center",
                justifyContent: "space-between",
                gap: phone() ? 0 : space[8],
              }}
            >
              <Label
                variant="small"
                lines={1}
                style={phone() ? undefined : { flexShrink: 1 }}
              >
                {entry().label}
              </Label>
              <If when={entry().detail}>
                <Label
                  tone="muted"
                  variant="small"
                  lines={1}
                  style={phone() ? undefined : { flexShrink: 1 }}
                >
                  {entry().detail}
                </Label>
              </If>
            </View>
            <If when={phone()}>
              <View style={{ opacity: opacity.disabled }}>
                <Icon name="right" size={icon.md} />
              </View>
            </If>
          </View>
        )}
      </Each>
      <If when={(loading() || busy()) && rows().length === 0}>
        <ListSkeleton
          label={localizedText("Waiting for the machine…", "正在等待机器响应…")}
          style={{ paddingHorizontal: space[8] }}
        />
      </If>
      <If when={rows().length > 0 && (loading() || busy())}>
        <Label tone="muted" style={{ padding: space[16] }}>
          {waiting()}
        </Label>
      </If>
      <If
        when={
          rows().length === 0 &&
          !error() &&
          kind() !== "github" &&
          kind() !== "new-name"
        }
      >
        <EmptyState
          size="row"
          status={loading() || busy() ? "loading" : "empty"}
          loading={waiting()}
          error={null}
          empty={{ title: nothing() }}
          announce={!!query()}
          style={{ padding: space[16] }}
        />
      </If>
      <If when={kind() === "github" && rows().length === 0 && !loading()}>
        <Label tone="muted" style={{ padding: space[16] }}>
          {localizedText(
            "Paste a Git URL or enter owner/repo.",
            "粘贴 Git URL 或输入 owner/repo。",
          )}
        </Label>
      </If>
      <If when={cloneProgress()}>
        {(active) => (
          <View style={{ padding: space[16], gap: space[8] }}>
            <Label>
              {localizedText(
                `Cloning ${active().repo}…`,
                `正在克隆 ${active().repo}…`,
              )}
            </Label>
            <Label tone="muted">
              {active().progress
                ? `${active().progress?.phase}${active().progress?.percent == null ? "" : ` ${active().progress?.percent}%`}`
                : active().target.display}
            </Label>
            <If when={cloneSlow()}>
              <Label variant="small" tone="warningInk">
                {uiText("takingLongerThanUsual")}
              </Label>
            </If>
            <Button
              label={localizedText("Cancel clone", "取消克隆")}
              disabled={cancelling() || !host.can("places.cancelClone")}
              onPress={() => void cancelClone()}
            />
          </View>
        )}
      </If>
    </>
  );
}
