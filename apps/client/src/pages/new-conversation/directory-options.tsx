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
import { keymap, View } from "nsh";
import { Input } from "nsh/base";
import { Button, colors, grow, Icon, Label, row } from "../../components";
import { localizedText } from "../../i18n";
import { useHost } from "../../services/host";

export function DirectoryOptions(props: {
  picker: ReturnType<typeof usePlaceFlow>;
  title: string;
  layout: Layout;
}) {
  const host = useHost();
  const phone = () => props.layout === "phone";
  const c = colors();
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
            marginHorizontal: 16,
            marginTop: 16,
            marginBottom: 8,
            paddingLeft: 12,
            borderWidth: 1,
            borderColor: c().ink,
          }}
        >
          <Icon name="search" size={14} />
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
                  height: 38,
                  paddingHorizontal: 8,
                  color: c().ink,
                  placeholderColor: c().muted,
                  fontSize: 14,
                }}
              />
            )}
          </Each>
        </View>
      </If>
      <If when={kind() === "method"}>
        <View
          style={{
            ...row,
            gap: 6,
            minHeight: 29,
            paddingHorizontal: 16,
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <If when={phone()}>
            <Icon name="panel" size={14} />
          </If>
          <Label size={13}>{machineName()}</Label>
        </View>
        <Label
          tone="muted"
          size={14}
          style={{ paddingHorizontal: 16, paddingVertical: 7 }}
        >
          {localizedText("How do you want to add it?", "你想怎样添加目录？")}
        </Label>
      </If>
      <If when={kind() === "browse" && listing()}>
        <View
          style={{ ...row, paddingHorizontal: 16, gap: 5, flexWrap: "wrap" }}
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
          size={10}
          tone="muted"
          style={{
            paddingHorizontal: 16,
            paddingVertical: 6,
            letterSpacing: 0.8,
            borderBottomWidth: 1,
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
            focusVisibleStyle={{
              outlineWidth: 1,
              outlineColor: c().blue,
              outlineOffset: -1,
            }}
            hoverStyle={{ backgroundColor: c().selected }}
            style={{
              ...row,
              minHeight: phone() ? 56 : 29,
              marginHorizontal: props.layout === "desktop" ? 12 : 16,
              paddingHorizontal: phone() ? 6 : 0,
              gap: 10,
              borderBottomWidth: phone() ? 1 : 0,
              borderColor: c().border,
              backgroundColor:
                selected() === index() ? c().selected : c().canvas,
              cursor: entry().disabled ? "default" : "pointer",
              opacity: entry().disabled ? 0.5 : 1,
            }}
          >
            <If when={phone()}>
              <Icon name={entry().icon} size={16} />
            </If>
            <View
              style={{
                ...grow,
                flexDirection: phone() ? "column" : "row",
                alignItems: phone() ? "stretch" : "center",
                justifyContent: "space-between",
                gap: phone() ? 0 : 8,
              }}
            >
              <Label
                size={phone() ? 14 : 12}
                weight={500}
                lines={1}
                style={phone() ? undefined : { flexShrink: 1 }}
              >
                {entry().label}
              </Label>
              <If when={entry().detail}>
                <Label
                  tone="muted"
                  size={phone() ? 11 : 12}
                  lines={1}
                  style={phone() ? undefined : { flexShrink: 1 }}
                >
                  {entry().detail}
                </Label>
              </If>
            </View>
            <If when={phone()}>
              <Icon name="right" size={11} tone="faint" />
            </If>
          </View>
        )}
      </Each>
      <If when={loading() || busy()}>
        <Label tone="muted" style={{ padding: 16 }}>
          {localizedText("Waiting for the machine…", "正在等待机器响应…")}
        </Label>
      </If>
      <If
        when={
          kind() === "search" &&
          query() &&
          !loading() &&
          rows().length === 0 &&
          !error()
        }
      >
        <Label tone="muted" style={{ padding: 16 }}>
          {localizedText(
            "No directories match this search.",
            "没有匹配的目录。",
          )}
        </Label>
      </If>
      <If when={kind() === "github" && rows().length === 0 && !loading()}>
        <Label tone="muted" style={{ padding: 16 }}>
          {localizedText(
            "Paste a Git URL or enter owner/repo.",
            "粘贴 Git URL 或输入 owner/repo。",
          )}
        </Label>
      </If>
      <If when={cloneProgress()}>
        {(active) => (
          <View style={{ padding: 16, gap: 8 }}>
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
