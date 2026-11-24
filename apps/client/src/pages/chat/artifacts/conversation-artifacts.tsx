import type { ArtifactView } from "@eta/client-contracts";
import type { ScrollRef, Signal, ViewRef } from "nsh";
import type { ArtifactFilters, ArtifactSort } from "./filter";
import { keymap, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  Empty,
  Field,
  grow,
  Icon,
  Label,
  ListSkeleton,
  row,
  SmoothScroll,
  textFaces,
  textStyle,
} from "../../../components";
import { control, icon, opacity, space } from "../../../components/tokens";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";
import { SectionHeading, ViewAll } from "../section-heading";
import {
  applyFilters,
  cleared,
  isFiltered,
  NO_PUBLISHER,
  pageRows,
  pageWindow,
  publisherCounts,
  RECENT,
  recentArtifacts,
  sorts,
  timeOf,
  withFilter,
  withTaskCount,
} from "./filter";
import { ArtifactRow } from "./row";

const sortLabels = {
  updated: "artifactsSortUpdated",
  created: "artifactsSortCreated",
  title: "artifactsSortTitle",
} as const satisfies Record<ArtifactSort, string>;

const groupLabels = {
  today: "todayDate",
  yesterday: "yesterdayDate",
  earlier: "earlierDate",
} as const;

/**
 * A group's artifacts in the side panel: the latest few in the Context tab, all of them in the
 * Artifacts tab with search, a Filter menu (sort, only, publishers) and pages of 15, as the web
 * app's tab has them.
 */
export function ConversationArtifacts(props: {
  conversationId: string;
  tab: string;
  filters: Signal<ArtifactFilters>;
  phone: boolean;
  onOpen: (artifact: ArtifactView) => void;
  onTask: (id: string) => void;
  /** The context tab's "View all": to the Artifacts tab. */
  onViewAll?: () => void;
  reload: () => void;
}) {
  const c = colors();
  const host = useHost();
  const artifacts = () =>
    host
      .artifacts()
      .filter((entry) => entry.conversationId === props.conversationId);
  return (
    <If
      when={props.tab === "Artifacts"}
      else={
        <RecentArtifacts
          artifacts={artifacts()}
          phone={props.phone}
          onOpen={props.onOpen}
          onTask={props.onTask}
          onViewAll={props.onViewAll}
        />
      }
    >
      <View style={grow}>
        <If
          when={artifacts().length}
          else={
            <If
              when={
                host.state().targets.artifacts || host.state().missing.artifacts
              }
              else={<ListSkeleton label={uiText("artifactsLoading")} />}
            >
              <Empty
                icon={host.state().missing.artifacts ? "warning" : "appWindow"}
                iconSize={icon.lg}
                iconTone={host.state().missing.artifacts ? "red" : "muted"}
                descriptionVariant="caption"
                style={{
                  flex: 0,
                  marginTop: space[16],
                  paddingVertical: space[48],
                }}
                title={
                  host.state().missing.artifacts
                    ? uiText("artifactLoadError")
                    : uiText("noArtifactsYet")
                }
                description={
                  host.state().missing.artifacts
                    ? uiText("theHostDidNotRespondIn")
                    : uiText("artifactsEmptyHelp")
                }
              >
                <If when={host.state().missing.artifacts}>
                  <Button
                    label={uiText("retry")}
                    icon="refresh"
                    size={control.md}
                    style={{ marginTop: space[4] }}
                    onPress={props.reload}
                  />
                </If>
              </Empty>
            </If>
          }
        >
          <ArtifactBrowser
            artifacts={artifacts()}
            filters={props.filters}
            phone={props.phone}
            onOpen={props.onOpen}
            onTask={props.onTask}
          />
        </If>
      </View>
    </If>
  );

  function RecentArtifacts(recent: {
    artifacts: ArtifactView[];
    phone: boolean;
    onOpen: (artifact: ArtifactView) => void;
    onTask: (id: string) => void;
    onViewAll?: () => void;
  }) {
    return (
      <View>
        <SectionHeading
          label={uiText("artifacts", { length: recent.artifacts.length })}
        >
          <If when={recent.artifacts.length > RECENT}>
            <ViewAll
              label={uiText("artifactsViewAll")}
              onPress={() => recent.onViewAll?.()}
            />
          </If>
        </SectionHeading>
        <If when={!recent.artifacts.length}>
          <Label
            variant="small"
            tone="muted"
            style={{
              paddingHorizontal: space[12],
              paddingBottom: space[8],
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            {uiText("noArtifactsYet")}
          </Label>
        </If>
        <Each of={recentArtifacts(recent.artifacts)} key={(a) => a.id}>
          {(artifact) => (
            <ArtifactRow
              artifact={artifact()}
              placement="context"
              phone={recent.phone}
              onPress={() => recent.onOpen(artifact())}
              onTask={recent.onTask}
            />
          )}
        </Each>
      </View>
    );
  }
}

/** Every artifact of a group: search, filter, sort and pages over the list the host sent. */
export function ArtifactBrowser(props: {
  artifacts: ArtifactView[];
  filters: Signal<ArtifactFilters>;
  phone: boolean;
  onOpen: (artifact: ArtifactView) => void;
  onTask: (id: string) => void;
}) {
  const c = colors();
  const type = textFaces();
  const host = useHost();
  const filters = props.filters;
  const update = (patch: Partial<ArtifactFilters>) =>
    filters.set(withFilter(filters(), patch));
  const clear = () => filters.set(cleared(filters()));
  const shown = () => applyFilters(props.artifacts, filters());
  const view = () => pageRows(shown(), filters());
  const counts = () => publisherCounts(props.artifacts, filters());
  const narrowed = () => isFiltered(filters());
  const filterOn = () =>
    filters().publisher !== null || filters().withTask || filters().revised;
  const publisherLabel = (id: string) =>
    id === NO_PUBLISHER
      ? uiText("artifactPublisherUnavailable")
      : (host.agent(id)?.name ?? uiText("artifactPublisherUnavailable"));
  let searchInput: ViewRef | undefined;
  let list: ScrollRef | undefined;
  keymap.bind("/", () => searchInput?.focus(), { when: "notEditing" });
  // A new page starts at its top, as the web's tab does.
  const goTo = (page: number) => {
    update({ page });
    list?.scrollTo({ y: 0, animated: false });
  };
  return (
    <View style={grow}>
      <View
        style={{
          gap: space[4],
          padding: space[12],
          borderBottomWidth: 1,
          borderColor: c().border,
        }}
      >
        <View style={{ ...row, gap: space[8] }}>
          <View
            style={{
              ...row,
              flex: 1,
              minWidth: 0,
              height: props.phone ? 32 : 26,
              gap: space[8],
              paddingHorizontal: space[8],
              borderWidth: 1,
              borderColor: c().border,
              backgroundColor: c().canvas,
            }}
          >
            <Icon name="search" size={icon.sm} tone="muted" />
            <Field
              label={uiText("searchArtifacts")}
              placeholder={uiText("searchTitles")}
              inputRef={(node) => {
                searchInput = node;
              }}
              style={{
                flex: 1,
                height: props.phone ? 30 : 24,
                paddingHorizontal: 0,
                paddingVertical: space[4],
                borderWidth: 0,
                ...textStyle(type("small")),
              }}
              value={filters().query}
              onChange={(value) => update({ query: value })}
            />
            <If
              when={filters().query}
              else={
                <If when={!props.phone}>
                  <View
                    style={{
                      paddingHorizontal: space[4],
                      borderWidth: 1,
                      borderColor: c().border,
                    }}
                  >
                    <Label variant="caption" tone="muted">
                      /
                    </Label>
                  </View>
                </If>
              }
            >
              <View
                role="button"
                accessibilityLabel={uiText("artifactsClearSearch")}
                onPress={() => {
                  update({ query: "" });
                  searchInput?.focus();
                }}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={{ cursor: "pointer" }}
              >
                <Icon name="close" size={icon.sm} tone="muted" />
              </View>
            </If>
          </View>
          <FilterMenu />
        </View>
        <If when={narrowed()}>
          <View style={{ ...row, justifyContent: "space-between" }}>
            <Label variant="caption" tone="faint">
              {uiText("artifactsFound", {
                count: shown().length,
                total: props.artifacts.length,
              })}
            </Label>
            <View
              role="button"
              accessibilityLabel={uiText("artifactsClearFilters")}
              onPress={clear}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              hoverStyle={{ opacity: opacity.muted }}
              style={{ cursor: "pointer" }}
            >
              <Label variant="caption" tone="mutedInk">
                {uiText("artifactsClearFilters")}
              </Label>
            </View>
          </View>
        </If>
      </View>
      <SmoothScroll
        ref={(node) => {
          list = node;
        }}
        style={grow}
        scrollbar={false}
      >
        <If
          when={shown().length}
          else={
            <View
              style={{
                alignItems: "center",
                gap: space[12],
                paddingHorizontal: space[20],
                paddingVertical: space[40],
              }}
            >
              <Label
                variant="small"
                tone="muted"
                style={{ textAlign: "center" }}
              >
                {filters().query.trim()
                  ? uiText("artifactsNoMatch", {
                      query: filters().query.trim(),
                    })
                  : uiText("artifactsNoFilterMatch")}
              </Label>
              <Button
                label={uiText("artifactsClearFilters")}
                size={props.phone ? control.lg : control.sm}
                labelVariant="caption"
                onPress={clear}
              />
            </View>
          }
        >
          <Each of={view().rows} key={(entry) => entry.artifact.id}>
            {(entry) => (
              <>
                <If when={entry().heading ? entry().group : null}>
                  {(group) => (
                    <Label
                      variant="small"
                      tone="muted"
                      style={{
                        paddingHorizontal: space[12],
                        paddingTop: space[16],
                        paddingBottom: space[8],
                      }}
                    >
                      {uiText(groupLabels[group()])}
                    </Label>
                  )}
                </If>
                <ArtifactRow
                  artifact={entry().artifact}
                  placement="list"
                  phone={props.phone}
                  query={filters().query}
                  group={entry().group}
                  at={timeOf(entry().artifact, filters().sort)}
                  onPress={() => props.onOpen(entry().artifact)}
                  onTask={props.onTask}
                />
              </>
            )}
          </Each>
        </If>
      </SmoothScroll>
      <If when={shown().length}>
        <View
          role="navigation"
          style={{
            ...row,
            flexShrink: 0,
            height: space[40],
            borderTopWidth: 1,
            borderColor: c().border,
            backgroundColor: c().surface,
            justifyContent: "space-between",
            paddingHorizontal: space[12],
          }}
        >
          <Label variant="caption" tone="muted">
            {uiText("artifactsRange", {
              first: view().first,
              last: view().last,
              total: shown().length,
            })}
          </Label>
          <If when={view().pages > 1}>
            <View style={{ ...row, gap: props.phone ? space[4] : space[8] }}>
              <PageButton
                label="‹"
                phone={props.phone}
                accessibilityLabel={uiText("artifactsPreviousPage")}
                disabled={view().page === 1}
                onPress={() => goTo(view().page - 1)}
              />
              <Each of={pageWindow(view().page, view().pages)}>
                {(number) => (
                  <If
                    when={number() !== null}
                    else={
                      <Label variant="caption" tone="muted">
                        …
                      </Label>
                    }
                  >
                    <PageButton
                      label={String(number())}
                      phone={props.phone}
                      accessibilityLabel={uiText("artifactsPage", {
                        page: number(),
                      })}
                      selected={number() === view().page}
                      onPress={() => goTo(number()!)}
                    />
                  </If>
                )}
              </Each>
              <PageButton
                label="›"
                phone={props.phone}
                accessibilityLabel={uiText("artifactsNextPage")}
                disabled={view().page === view().pages}
                onPress={() => goTo(view().page + 1)}
              />
            </View>
          </If>
        </View>
      </If>
    </View>
  );

  function FilterMenu() {
    return (
      <ActionMenu
        label={uiText("artifactsFilter")}
        sheetTitle={uiText("artifactsFilter")}
        noCaret
        popupWidth={208}
        lifted
        leading={
          <View style={{ ...row, gap: space[4] }}>
            <Icon name="funnel" size={icon.sm} />
            <Label variant="small">{uiText("artifactsFilter")}</Label>
          </View>
        }
        triggerStyle={{
          height: props.phone ? 32 : 26,
          paddingHorizontal: space[12],
          borderWidth: 1,
          borderColor: filterOn() ? c().ink : c().border,
        }}
      >
        <MenuSection label={uiText("artifactsSort")} />
        <Each of={sorts}>
          {(sort) => (
            <ActionItem
              label={uiText(sortLabels[sort()])}
              checked={filters().sort === sort()}
              onSelect={() => update({ sort: sort() })}
            />
          )}
        </Each>
        <MenuSection label={uiText("artifactsOnly")} divided />
        <ActionItem
          label={uiText("artifactsWithTask")}
          detail={String(withTaskCount(props.artifacts))}
          checked={filters().withTask}
          onSelect={() => update({ withTask: !filters().withTask })}
        />
        <ActionItem
          label={uiText("artifactsRevised")}
          checked={filters().revised}
          onSelect={() => update({ revised: !filters().revised })}
        />
        <If when={counts().publishers.length > 1}>
          <MenuSection label={uiText("artifactsPublishers")} divided />
          <ActionItem
            label={uiText("artifactsAll")}
            detail={String(counts().all)}
            checked={filters().publisher === null}
            onSelect={() => update({ publisher: null })}
          />
          <Each of={counts().publishers} key={(entry) => entry.id}>
            {(entry) => (
              <ActionItem
                label={publisherLabel(entry().id)}
                detail={String(entry().count)}
                checked={filters().publisher === entry().id}
                onSelect={() => update({ publisher: entry().id })}
              />
            )}
          </Each>
        </If>
      </ActionMenu>
    );
  }

  function MenuSection(section: { label: string; divided?: boolean }) {
    return (
      <View
        style={{
          ...row,
          minHeight: props.phone ? control.md : space[24],
          paddingHorizontal: props.phone ? space[16] : space[8],
          borderTopWidth: section.divided ? 1 : 0,
          borderColor: c().border,
        }}
      >
        <Label variant="caption" tone="faint">
          {section.label}
        </Label>
      </View>
    );
  }
}

function PageButton(props: {
  label: string;
  accessibilityLabel?: string;
  selected?: boolean;
  disabled?: boolean;
  phone?: boolean;
  onPress: () => void;
}) {
  const c = colors();
  return (
    <View
      role="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={{
        selected: props.selected,
        disabled: props.disabled ?? false,
      }}
      onPress={() => {
        if (!props.disabled) props.onPress();
      }}
      style={{
        ...row,
        justifyContent: "center",
        height: props.phone ? 32 : 22,
        minWidth: props.phone ? control.md : space[20],
        borderWidth: props.selected ? 1 : 0,
        borderColor: c().ink,
        opacity: props.disabled ? opacity.disabled : 1,
        cursor: props.disabled ? "default" : "pointer",
      }}
    >
      <Label variant="caption" tone={props.selected ? "ink" : "muted"}>
        {props.label}
      </Label>
    </View>
  );
}
