import type { ArtifactView } from "@eta/client-contracts";
import type { ScrollRef, Signal, ViewRef } from "nsh";
import type { ArtifactFilters, ArtifactSort } from "./filter";
import { keymap, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  colors,
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
import { EmptyState } from "../../../components/empty-state";
import {
  control,
  icon,
  opacity,
  sizes,
  space,
} from "../../../components/tokens";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";
import { useLoadState } from "../../../services/load-status";
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

/** The filter menu's width. */
const filterMenuWidth = 208;

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
  const load = useLoadState({ targets: () => ["artifacts"] });
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
          when={artifacts().length && load.status() === "ready"}
          else={
            <EmptyState
              size="page"
              width="narrow"
              status={load.shown()}
              loading={<ListSkeleton label={uiText("artifactsLoading")} />}
              error={{
                title: uiText("artifactLoadError"),
                description: load.why(),
                retry: props.reload,
              }}
              empty={{
                art: "artifacts",
                title: uiText("noArtifactsYet"),
                description: uiText("artifactsEmptyHelp"),
              }}
              style={{
                paddingHorizontal: space[16],
                paddingVertical: space[24],
              }}
            />
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
          <EmptyState
            size="row"
            status={load.shown()}
            loading={uiText("artifactsLoading")}
            error={{
              title: uiText("artifactLoadError"),
              retry: props.reload,
            }}
            empty={{ title: uiText("noArtifactsYet") }}
            style={{
              paddingHorizontal: space[12],
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          />
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
          ...row,
          justifyContent: "space-between",
          alignItems: "center",
          height: sizes.sectionHeader,
          gap: space[8],
          paddingHorizontal: space[12],
          borderBottomWidth: 1,
          borderColor: c().border,
        }}
      >
        <View style={{ ...row, flex: 1, minWidth: 0, gap: space[8] }}>
          <Icon name="search" size={icon.sm} tone="muted" />
          <Field
            label={uiText("searchArtifacts")}
            placeholder={uiText("searchTitles")}
            inputRef={(node) => {
              searchInput = node;
            }}
            style={{
              flex: 1,
              height: sizes.sectionHeader - 2,
              paddingHorizontal: 0,
              paddingVertical: 0,
              borderWidth: 0,
              backgroundColor: "transparent",
              ...textStyle(type("small")),
            }}
            value={filters().query}
            onChange={(value) => update({ query: value })}
          />
          <If when={filters().query}>
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
        <View
          style={{
            ...row,
            justifyContent: "space-between",
            paddingHorizontal: space[12],
            paddingVertical: space[8],
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
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
            <EmptyState
              size="page"
              width="narrow"
              status="empty"
              loading={null}
              error={null}
              empty={{
                title: filters().query.trim()
                  ? uiText("artifactsNoMatch", {
                      query: filters().query.trim(),
                    })
                  : uiText("artifactsNoFilterMatch"),
                actions: [
                  { label: uiText("artifactsClearFilters"), onPress: clear },
                ],
              }}
              announce
              style={{
                paddingHorizontal: space[16],
                paddingVertical: space[24],
              }}
            />
          }
        >
          <Each of={view().rows} key={(entry) => entry.artifact.id}>
            {(entry) => (
              <>
                <If when={entry().heading ? entry().group : null}>
                  {(group) => (
                    <SectionHeading label={uiText(groupLabels[group()])} />
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
        popupWidth={filterMenuWidth}
        lifted
        leading={
          <Icon
            name="funnel"
            size={icon.sm}
            tone={filterOn() ? "ink" : "muted"}
          />
        }
        value={uiText("artifactsFilter")}
        valueTone={filterOn() ? "ink" : "muted"}
        triggerStyle={{
          borderWidth: 0,
          height: control.sm,
          marginVertical: -space[4],
          marginRight: -space[8],
          paddingHorizontal: space[8],
          gap: space[4],
          flexShrink: 0,
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
        height: props.phone ? control.lg : control.sm,
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
