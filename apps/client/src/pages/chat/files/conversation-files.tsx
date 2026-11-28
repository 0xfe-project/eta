import type {
  ProjectDirectoryListing,
  ProjectResults,
  ProjectView,
} from "@eta/client-contracts";
import type { ViewRef } from "nsh";
import { cleanup, computed, effect, signal, View } from "nsh";
import {
  Button,
  colors,
  Field,
  focusRing,
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
import { problemText } from "../../../services/problem-text";
import { directoryCrumbs, parentDirectory } from "./format";

/** Read-only workspace browser for one project, on the primary or a remote daemon machine. */
export function ConversationFiles(props: {
  project: ProjectView;
  /** Shown beside the path when the project lives on a remote machine. */
  machineName?: string;
  phone: boolean;
  onOpenFile: (path: string) => void;
}) {
  const host = useHost();
  const c = colors();
  const type = textFaces();
  const currentPath = signal("");
  const query = signal("");
  const listing = signal<ProjectDirectoryListing | undefined>(undefined);
  const loading = signal(true);
  const error = signal<unknown>(undefined);
  const revision = signal(0);
  const cache = new Map<string, ProjectDirectoryListing>();
  let searchInput: ViewRef | undefined;

  let lastProjectId = props.project.id;
  effect(() => {
    const projectId = props.project.id;
    if (projectId !== lastProjectId) {
      lastProjectId = projectId;
      cache.clear();
      currentPath.set("");
      query.set("");
    }
    const dir = currentPath();
    void revision();
    const cacheKey = `${projectId}:${dir}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      listing.set(cached);
      loading.set(false);
      error.set(undefined);
      return;
    }
    let active = true;
    cleanup(() => {
      active = false;
    });
    loading.set(true);
    error.set(undefined);
    void host
      .call<ProjectResults["directory"]>("projects", "directory", {
        projectId,
        ...(dir ? { path: dir } : {}),
      })
      .then((result) => {
        if (!active) return;
        cache.set(cacheKey, result);
        listing.set(result);
        loading.set(false);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        error.set(cause);
        loading.set(false);
      });
  });

  function openDirectory(path: string) {
    query.set("");
    currentPath.set(path);
  }

  function refresh() {
    cache.clear();
    revision.set(revision() + 1);
  }

  const normalizedQuery = () => query().trim().toLowerCase();
  const filteredEntries = computed(() => {
    const entries = listing()?.entries ?? [];
    const q = normalizedQuery();
    if (!q) return entries;
    return entries.filter((entry) => entry.name.toLowerCase().includes(q));
  });
  const crumbs = computed(() => directoryCrumbs(currentPath()));
  const rowHeight = () => (props.phone ? control.touch : space[32]);

  return (
    <View style={grow}>
      <View
        style={{
          ...row,
          height: sizes.sectionHeader,
          gap: space[8],
          paddingLeft: space[12],
          paddingRight: space[8],
          flexShrink: 0,
          borderBottomWidth: 1,
          borderColor: c().border,
        }}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label variant="caption" tone="muted" lines={1}>
            {[props.machineName, props.project.display]
              .filter(Boolean)
              .join(" · ")}
          </Label>
        </View>
        <Button
          label={uiText("filesRefresh")}
          tooltip={uiText("filesRefresh")}
          icon="refresh"
          iconOnly
          tone="ghost"
          labelTone="muted"
          hoverTone="ink"
          size={control.sm}
          onPress={refresh}
        />
      </View>
      <View
        style={{
          ...row,
          height: sizes.sectionHeader,
          gap: space[8],
          paddingHorizontal: space[12],
          flexShrink: 0,
          borderBottomWidth: 1,
          borderColor: c().border,
        }}
      >
        <Icon name="search" size={icon.sm} tone="muted" />
        <Field
          label={uiText("filesSearch")}
          placeholder={uiText("filesSearchPlaceholder")}
          inputRef={(node) => {
            searchInput = node;
          }}
          style={{
            flex: 1,
            height: sizes.sectionHeader - space[2],
            paddingHorizontal: 0,
            paddingVertical: 0,
            borderWidth: 0,
            backgroundColor: "transparent",
            ...textStyle(type("small")),
          }}
          value={query()}
          onChange={query.set}
        />
        <If when={query()}>
          <View
            role="button"
            accessibilityLabel={uiText("filesClearSearch")}
            onPress={() => {
              query.set("");
              searchInput?.focus();
            }}
            hitSlop={{
              top: space[8],
              bottom: space[8],
              left: space[8],
              right: space[8],
            }}
            style={{ cursor: "pointer" }}
          >
            <Icon name="close" size={icon.sm} tone="muted" />
          </View>
        </If>
      </View>
      <If when={currentPath()}>
        <View
          style={{
            ...row,
            minHeight: space[32],
            gap: space[4],
            paddingHorizontal: space[8],
            paddingVertical: space[4],
            flexShrink: 0,
            flexWrap: "wrap",
            borderBottomWidth: 1,
            borderColor: c().border,
            backgroundColor: c().canvas,
          }}
        >
          <Button
            label={uiText("filesUp")}
            icon="back"
            iconOnly
            tone="ghost"
            labelTone="muted"
            hoverTone="ink"
            size={control.sm}
            onPress={() => openDirectory(parentDirectory(currentPath()))}
          />
          <View
            role="button"
            accessibilityLabel={uiText("filesRoot")}
            onPress={() => openDirectory("")}
            hoverStyle={{ opacity: opacity.muted }}
            focusVisibleStyle={focusRing(c())}
            style={{ cursor: "pointer", paddingHorizontal: space[4] }}
          >
            <Label variant="caption" tone="muted">
              {props.project.name}
            </Label>
          </View>
          <Each of={crumbs()} key={(crumb) => crumb.path}>
            {(crumb) => (
              <View style={{ ...row, gap: space[4] }}>
                <Label variant="caption" tone="faint">
                  /
                </Label>
                <View
                  role="button"
                  accessibilityLabel={crumb().label}
                  onPress={() => openDirectory(crumb().path)}
                  hoverStyle={{ opacity: opacity.muted }}
                  focusVisibleStyle={focusRing(c())}
                  style={{ cursor: "pointer", paddingHorizontal: space[4] }}
                >
                  <Label
                    variant="caption"
                    tone={crumb().path === currentPath() ? "ink" : "muted"}
                    lines={1}
                  >
                    {crumb().label}
                  </Label>
                </View>
              </View>
            )}
          </Each>
        </View>
      </If>
      <If
        when={!loading() && !error() && filteredEntries().length > 0}
        else={
          <EmptyState
            size="page"
            width="narrow"
            status={loading() ? "loading" : error() ? "error" : "empty"}
            loading={<ListSkeleton label={uiText("filesLoading")} />}
            error={{
              title: uiText("filesLoadError"),
              description: error() ? problemText(error()) : undefined,
              retry: refresh,
            }}
            empty={
              normalizedQuery()
                ? {
                    title: uiText("filesNoMatch", { query: query().trim() }),
                    actions: [
                      {
                        label: uiText("filesClearSearch"),
                        onPress: () => {
                          query.set("");
                          searchInput?.focus();
                        },
                      },
                    ],
                  }
                : { title: uiText("filesEmpty") }
            }
            style={{
              paddingHorizontal: space[16],
              paddingVertical: space[24],
            }}
          />
        }
      >
        <SmoothScroll style={grow} scrollbar={false}>
          <View style={{ paddingVertical: space[4] }}>
            <Each of={filteredEntries()} key={(entry) => entry.path}>
              {(entry) => (
                <View
                  role="button"
                  accessibilityLabel={entry().name}
                  onPress={() => {
                    if (entry().kind === "directory")
                      openDirectory(entry().path);
                    else props.onOpenFile(entry().path);
                  }}
                  hoverStyle={{ backgroundColor: c().selected }}
                  focusVisibleStyle={focusRing(c())}
                  style={{
                    ...row,
                    height: rowHeight(),
                    paddingHorizontal: space[12],
                    gap: space[8],
                    cursor: "pointer",
                  }}
                >
                  <Icon
                    name={entry().kind === "directory" ? "folder" : "file"}
                    size={icon.sm}
                    tone="muted"
                  />
                  <Label
                    variant="small"
                    lines={1}
                    style={{
                      flex: 1,
                      opacity: entry().hidden ? opacity.muted : 1,
                    }}
                  >
                    {entry().name}
                  </Label>
                  <If when={entry().kind === "directory"}>
                    <Icon name="right" size={icon.sm} tone="muted" />
                  </If>
                </View>
              )}
            </Each>
            <If when={listing()?.truncated}>
              <View
                style={{
                  paddingHorizontal: space[12],
                  paddingVertical: space[8],
                }}
              >
                <Label variant="caption" tone="faint">
                  {uiText("filesTruncated", {
                    count: listing()?.entries.length ?? 0,
                  })}
                </Label>
              </View>
            </If>
          </View>
        </SmoothScroll>
      </If>
    </View>
  );
}
