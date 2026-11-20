import type {
  CloneView,
  ConversationResults,
  FlowPage,
  MachineView,
  PlaceFailure,
  PlaceListing,
  PlaceMatch,
  PlaceRef,
  PlacesAction,
  PlacesArgs,
  PlacesResults,
  ProjectResults,
  RecentPlace,
} from "@eta/client-contracts";
import type { IconName } from "./icons";
import type { Layout } from "./ui";
import {
  back,
  buildSuggestions,
  childDisplay,
  chooseMachine,
  chooseMethod,
  chooseNewParent,
  chooseRepo,
  clampActive,
  currentPage,
  machineOptions,
  manualRepoChoices,
  methodOptions,
  moveActive,
  openBrowse,
  openFlow,
  pageKey,
  parentsOf,
  PLACE_PROBLEMS,
  repoName,
  repoOptions,
  setActive,
  setMachines,
  setQuery,
  setShowHidden,
} from "@eta/client-contracts";
import { WireError } from "@eta/client-contracts/wire";
import {
  cleanup,
  computed,
  effect,
  keymap,
  Scroll,
  signal,
  View,
  windowSize,
} from "nsh";
import { Input } from "nsh/base";
import { follow, useHost } from "./host";
import { formatLocale, uiText } from "./locale";
import { AgentFace } from "./shell";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  Field,
  grow,
  Icon,
  Label,
  Modal,
  row,
} from "./ui";

interface DirectoryChoice extends PlaceRef {
  machineId: string;
  name?: string;
  projectId?: string | null;
}

interface ChoiceRow {
  id: string;
  label: string;
  detail?: string;
  icon: IconName;
  disabled?: boolean;
  select: () => void;
}

const copy = (en: string, zh: string) =>
  formatLocale().startsWith("zh") ? zh : en;

function placeFailure(error: unknown): PlaceFailure {
  const problem = error instanceof WireError ? error.problem : undefined;
  const code = PLACE_PROBLEMS.find((code) => code === problem?.code) ?? "other";
  const detail = problem?.params?.detail;
  if (typeof detail === "string" && detail) return { code, detail };
  return code === "other" ? { code, detail: String(error) } : { code };
}

function failureText(failure: PlaceFailure) {
  switch (failure.code) {
    case "offline":
      return copy("This machine is offline.", "这台机器已离线。");
    case "timeout":
      return copy("The machine did not answer in time.", "机器响应超时。");
    case "unsupported":
      return copy(
        "This action is unavailable on this machine.",
        "这台机器不支持此操作。",
      );
    case "not_found":
      return copy("That directory does not exist.", "该目录不存在。");
    case "denied":
      return copy(
        "The machine denied access to this directory.",
        "机器拒绝访问该目录。",
      );
    case "not_directory":
      return copy("That path is not a directory.", "该路径不是目录。");
    case "exists":
      return copy(
        "A directory with that name already exists.",
        "同名目录已存在。",
      );
    case "invalid":
      return copy(
        "Enter a valid path, directory name, or repository URL.",
        "请输入有效的路径、目录名称或仓库 URL。",
      );
    case "not_absolute":
      return copy(
        "Enter an absolute path or start with ~.",
        "请输入绝对路径或以 ~ 开头的路径。",
      );
    case "auth":
      return copy(
        "Git could not authenticate to this repository.",
        "Git 无法验证该仓库的访问权限。",
      );
    case "network":
      return copy(
        "Git could not reach the repository.",
        "Git 无法连接该仓库。",
      );
    case "repo_not_found":
      return copy("Git could not find the repository.", "Git 找不到该仓库。");
    case "cancelled":
      return copy("Clone cancelled.", "已取消克隆。");
    case "no_git":
      return copy(
        "Git is unavailable on this machine.",
        "这台机器未安装 Git。",
      );
    case "gh_signed_out":
      return copy(
        "GitHub CLI is signed out. Paste a repository URL.",
        "GitHub CLI 尚未登录。请粘贴仓库 URL。",
      );
    default:
      return (
        failure.detail ||
        copy(
          "The machine could not complete this action.",
          "机器无法完成该操作。",
        )
      );
  }
}

export function NewConversation(props: {
  layout: Layout;
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const host = useHost();
  const c = colors();
  const phone = () => props.layout === "phone";
  follow(() => "machines");
  follow(() => "places");
  const machines = () =>
    host
      .list<MachineView>("machines")
      .filter(
        (machine) =>
          machine.status !== "pending" && machine.status !== "revoked",
      );
  const flow = signal(openFlow({ machines: machines() }));
  effect(() => {
    const values = machines();
    flow.update((state) => setMachines(state, values));
  });
  const page = () => currentPage(flow());
  const machineId = computed(() => {
    const current = page();
    return current.kind === "machine" ? undefined : current.machineId;
  });
  const machine = () => machines().find((entry) => entry.id === machineId());
  const machineName = () => machine()?.name ?? copy("Machine", "机器");
  const directory = signal<DirectoryChoice | undefined>(undefined);
  const name = signal("");
  const picked = signal<string[] | undefined>(undefined);
  const agents = () =>
    picked() ??
    host
      .agents()
      .slice(0, 1)
      .map((agent) => agent.id);
  const steward = signal<string | null | undefined>(undefined);
  const advanced = signal(false);
  const currentSteward = () =>
    steward() === null ? null : (steward() ?? agents()[0]);
  const toggleAgent = (id: string) => {
    const members = agents();
    const next = members.includes(id)
      ? members.filter((member) => member !== id)
      : [...members, id];
    picked.set(next);
    if (!next.length || (steward() === id && !next.includes(id)))
      steward.set(undefined);
  };
  const busy = signal(false);
  const saving = signal(false);
  const error = signal<PlaceFailure | undefined>(undefined);
  const clone = signal<CloneView | undefined>(undefined);
  const cancelling = signal(false);

  function place<K extends PlacesAction>(op: K, args: PlacesArgs[K]) {
    return host.call<PlacesResults[K]>("places", op, args);
  }

  const capabilities = signal<PlacesResults["capabilities"] | undefined>(
    undefined,
  );
  const capabilitiesAvailable = computed(() => host.can("places.capabilities"));
  effect(() => {
    const id = machineId();
    capabilities.set(undefined);
    if (!id || !capabilitiesAvailable()) return;
    let current = true;
    void place("capabilities", { machineId: id }).then(
      (value) => {
        if (current) capabilities.set(value);
      },
      (failure: unknown) => {
        if (current) error.set(placeFailure(failure));
      },
    );
    cleanup(() => {
      current = false;
    });
  });

  const listing = signal<PlaceListing | undefined>(undefined);
  const matches = signal<PlaceMatch[]>([]);
  const repositories = signal<PlacesResults["repos"] | undefined>(undefined);
  const loading = signal(false);
  const query = computed(() => page().query.trim());
  const kind = computed(() => page().kind);
  const browsePath = computed(() => {
    const current = page();
    return current.kind === "browse" ? current.path : null;
  });
  const canBrowse = computed(() => host.can("places.list"));
  const canSearch = computed(() => host.can("places.search"));
  const canSearchGitHub = computed(
    () => capabilities()?.gh === "ready" && host.can("places.repos"),
  );
  effect(() => {
    const id = machineId();
    const mode = kind();
    const filter = mode === "browse" ? "" : query();
    const path = mode === "browse" ? browsePath() : null;
    const githubSearch = mode === "github" && canSearchGitHub();
    listing.set(undefined);
    matches.set([]);
    repositories.set(undefined);
    loading.set(false);
    if (!id) return;
    const browsing = mode === "browse" && canBrowse();
    const searching =
      filter &&
      (mode === "search" ||
        mode === "clone-location" ||
        mode === "new-parent") &&
      canSearch();
    if (!browsing && !searching && !githubSearch) return;
    let current = true;
    loading.set(true);
    const timer = setTimeout(
      () => {
        const request = browsing
          ? place("list", { machineId: id, path: path ?? undefined }).then(
              (value) => {
                if (current) listing.set(value);
              },
            )
          : githubSearch
            ? place("repos", { machineId: id, query: filter }).then((value) => {
                if (current) repositories.set(value);
              })
            : place("search", { machineId: id, query: filter, limit: 40 }).then(
                (value) => {
                  if (current) matches.set(value.matches);
                },
              );
        void request
          .catch((failure: unknown) => {
            if (current) error.set(placeFailure(failure));
          })
          .finally(() => {
            if (current) loading.set(false);
          });
      },
      browsing ? 0 : 160,
    );
    cleanup(() => {
      current = false;
      clearTimeout(timer);
    });
  });

  function choose(
    id: string,
    place: PlaceRef & { projectId?: string | null; name?: string },
  ) {
    directory.set({ ...place, machineId: id });
    error.set(undefined);
  }

  async function perform<T>(
    request: () => Promise<T>,
    done: (result: T) => void,
  ) {
    if (busy()) return;
    busy.set(true);
    error.set(undefined);
    try {
      const result = await request();
      busy.set(false);
      done(result);
    } catch (failure) {
      busy.set(false);
      error.set(placeFailure(failure));
    }
  }

  async function cancelClone() {
    const active = clone();
    if (!active || cancelling() || !host.can("places.cancelClone")) return;
    cancelling.set(true);
    try {
      await place("cancelClone", { cloneId: active.id });
    } catch (failure) {
      error.set(placeFailure(failure));
    } finally {
      cancelling.set(false);
    }
  }

  const cloneProgress = () => {
    const active = clone();
    return (
      active &&
      (host
        .list<CloneView>("places", "clones")
        .find((entry) => entry.id === active.id) ??
        active)
    );
  };
  effect(() => {
    const active = cloneProgress();
    if (!active || active.status === "running") return;
    clone.set(undefined);
    if (active.status === "done") choose(active.machineId, active.target);
    else
      error.set(
        active.failure ?? {
          code: active.status === "cancelled" ? "cancelled" : "other",
        },
      );
  });

  function takeLocation(
    current: FlowPage,
    target: PlaceRef & { projectId?: string | null; name?: string },
  ) {
    if (current.kind === "machine") return;
    if (current.kind === "new-parent") {
      flow.update((state) => chooseNewParent(state, target));
    } else if (current.kind === "clone-location") {
      void perform(
        () =>
          place("clone", {
            machineId: current.machineId,
            url: current.repo.cloneUrl,
            protocol: current.repo.protocol,
            parent: target.path,
          }),
        (result) => clone.set(result.clone),
      );
    } else {
      choose(current.machineId, target);
    }
  }

  const recent = () =>
    host
      .list<RecentPlace>("places", "recent")
      .filter((entry) => entry.machineId === machineId());
  const rows = (): ChoiceRow[] => {
    const current = page();
    const caps = capabilities();
    switch (current.kind) {
      case "machine":
        return machineOptions(flow().machines, current.query).map(
          ({ machine: entry, closed }) => ({
            id: entry.id,
            label: entry.name,
            icon: "panel",
            disabled: !!closed,
            detail:
              closed === "ssh"
                ? copy(
                    "Directory browsing requires the Eta daemon",
                    "浏览目录需要 Eta 守护进程",
                  )
                : closed === "offline"
                  ? copy("Offline", "离线")
                  : undefined,
            select: () =>
              flow.update((state) => chooseMachine(state, entry.id)),
          }),
        );
      case "method": {
        const descriptions = {
          search: [
            uiText("searchDirectories"),
            copy(
              `Find a directory on ${machineName()}`,
              `在 ${machineName()} 上查找目录`,
            ),
            "search",
            "places.resolve",
          ],
          browse: [
            copy("Browse…", "浏览…"),
            copy("Walk the folders one level at a time", "逐级浏览文件夹"),
            "folder",
            "places.list",
          ],
          github: [
            copy("Clone from GitHub", "从 GitHub 克隆"),
            copy("Find a repository or paste its URL", "查找仓库或粘贴 URL"),
            "archive",
            "places.clone",
          ],
          new: [
            copy("New directory", "新建目录"),
            copy("Make an empty directory", "创建一个空目录"),
            "plus",
            "places.mkdir",
          ],
        } as const;
        return methodOptions(caps).map(({ id, disabled, note }) => {
          const [label, detail, icon, permission] = descriptions[id];
          return {
            id,
            label,
            icon,
            disabled: disabled || !host.can(permission),
            detail:
              note === "checking" && !error()
                ? copy("Checking machine capabilities…", "正在检查机器能力…")
                : note === "no_git"
                  ? failureText({ code: "no_git" })
                  : note === "update"
                    ? copy(
                        "Update the Eta daemon to create directories",
                        "更新 Eta 守护进程后可创建目录",
                      )
                    : note === "paste_only"
                      ? copy(
                          "gh is not signed in: paste a URL or owner/repo",
                          "gh 未登录：粘贴 URL 或 owner/repo",
                        )
                      : detail,
            select: () =>
              flow.update((state) =>
                chooseMethod(state, current.machineId, id),
              ),
          };
        });
      }
      case "search":
      case "new-parent":
      case "clone-location": {
        const flavor =
          caps?.flavor ?? (machine()?.os === "win32" ? "win32" : "posix");
        const preferred =
          current.kind === "clone-location"
            ? caps?.cloneParent
            : current.kind === "new-parent" && caps
              ? { path: caps.home, display: "~" }
              : undefined;
        const remembered =
          current.kind === "search"
            ? recent()
            : [...(preferred ? [preferred] : []), ...parentsOf(recent())];
        return buildSuggestions<
          PlaceRef & { name?: string; projectId?: string | null }
        >({
          query: current.query,
          flavor,
          os: machine()?.os,
          recent: remembered,
          found: matches(),
        }).map((choice) => {
          if (choice.kind === "typed")
            return {
              id: choice.path,
              label: choice.path,
              icon: "folder",
              detail: copy("Open this path", "打开此路径"),
              select: () =>
                void perform(
                  () =>
                    place("resolve", {
                      machineId: current.machineId,
                      path: choice.path,
                    }),
                  (checked) => {
                    if (checked.directory) takeLocation(current, checked);
                    else
                      error.set({
                        code: checked.exists ? "not_directory" : "not_found",
                      });
                  },
                ),
            };
          const target = choice.place;
          const projectName = host
            .projects()
            .find((project) => project.id === target.projectId)?.name;
          const title = target.name ?? projectName;
          const cloneName =
            current.kind === "clone-location"
              ? repoName(current.repo.cloneUrl)
              : undefined;
          return {
            id: target.path,
            label: cloneName
              ? childDisplay(target, cloneName, flavor)
              : (title ?? target.display),
            detail: cloneName
              ? copy(`Inside ${target.display}`, `位于 ${target.display}`)
              : title
                ? target.display
                : undefined,
            icon: "folder",
            select: () => takeLocation(current, target),
          };
        });
      }
      case "browse": {
        const found = listing();
        if (!found) return [];
        const walk = (path: string) =>
          flow.update((state) => openBrowse(state, current.machineId, path));
        return [
          {
            id: "here",
            label: uiText("useThisDirectory"),
            detail: found.display,
            icon: "check",
            select: () => choose(current.machineId, found),
          },
          ...(found.parent
            ? [
                {
                  id: "parent",
                  label: uiText("parentDirectory"),
                  detail: found.parent.display,
                  icon: "back" as const,
                  select: () => walk(found.parent!.path),
                },
              ]
            : []),
          ...found.entries
            .filter(
              (entry) =>
                (current.showHidden || !entry.hidden) &&
                entry.name.toLowerCase().includes(query().toLowerCase()),
            )
            .map((entry) => ({
              id: entry.path,
              label: entry.name,
              detail: entry.display,
              icon: "folder" as const,
              select: () => walk(entry.path),
            })),
        ];
      }
      case "github": {
        const found = repositories();
        return repoOptions(
          manualRepoChoices(current.query),
          found?.available ? found.repos : [],
        ).map((repo) => ({
          id: repo.id,
          label: repo.nameWithOwner,
          detail: repo.protocol?.toUpperCase() ?? repo.description ?? undefined,
          icon: "archive",
          select: () => flow.update((state) => chooseRepo(state, repo)),
        }));
      }
      case "new-name": {
        const name = current.query.trim();
        return name
          ? [
              {
                id: "create",
                label: copy("Create directory", "创建目录"),
                detail: childDisplay(
                  current.parent,
                  name,
                  caps?.flavor ?? "posix",
                ),
                icon: "plus",
                select: () =>
                  void perform(
                    () =>
                      place("mkdir", {
                        machineId: current.machineId,
                        parent: current.parent.path,
                        name,
                      }),
                    (made) => choose(current.machineId, made),
                  ),
              },
            ]
          : [];
      }
    }
  };
  const options = () => rows().map((entry) => !entry.disabled);
  const selected = () => clampActive(page().activeIndex, options());
  function select(entry: ChoiceRow | undefined) {
    if (!busy() && !clone() && entry && !entry.disabled) {
      error.set(undefined);
      entry.select();
    }
  }
  function previous() {
    if (clone()) {
      void cancelClone();
      return;
    }
    if (busy() || saving()) return;
    error.set(undefined);
    if (directory()) {
      directory.set(undefined);
      return;
    }
    const earlier = back(flow());
    if (earlier) flow.set(earlier);
    else props.onClose();
  }

  async function start() {
    const choice = directory();
    if (!choice || agents().length === 0 || saving()) return;
    saving.set(true);
    error.set(undefined);
    try {
      const existing = host
        .projects()
        .find(
          (project) =>
            project.kind === "project" &&
            !project.archived &&
            project.machineId === choice.machineId &&
            (project.id === choice.projectId || project.path === choice.path),
        );
      const project =
        existing ??
        (
          await host.call<ProjectResults["create"]>("projects", "create", {
            machineId: choice.machineId,
            path: choice.path,
          })
        ).project;
      directory.set({ ...choice, projectId: project.id });
      const created = await host.call<ConversationResults["create"]>(
        "conversations",
        "create",
        {
          projectId: project.id,
          name: name().trim() || undefined,
          agentIds: agents(),
          stewardId: currentSteward(),
        },
      );
      if (host.can("places.remember"))
        void place("remember", {
          machineId: choice.machineId,
          path: choice.path,
        }).catch(() => {});
      props.onClose();
      props.onOpen(created.conversation.id);
    } catch (failure) {
      error.set(placeFailure(failure));
    } finally {
      saving.set(false);
    }
  }

  const methodStage = () =>
    !directory() && (kind() === "method" || kind() === "machine");
  const title = () => {
    if (methodStage() || directory()) return uiText("newConversation");
    switch (kind()) {
      case "search":
        return uiText("searchDirectories");
      case "browse":
        return uiText("browseDirectories");
      case "github":
        return copy("Clone from GitHub", "从 GitHub 克隆");
      case "clone-location":
        return copy("Clone location", "克隆位置");
      case "new-parent":
        return copy("New directory", "新建目录");
      default:
        return copy("Directory name", "目录名称");
    }
  };
  const placeholder = () => {
    switch (kind()) {
      case "machine":
        return copy("Search machines", "搜索机器");
      case "browse":
        return copy("Filter directories", "筛选目录");
      case "github":
        return copy("Search repositories or paste a URL", "搜索仓库或粘贴 URL");
      case "clone-location":
      case "new-parent":
        return copy(
          "Search for a parent directory or enter a path",
          "搜索上级目录或输入路径",
        );
      case "new-name":
        return copy("Name the directory", "输入目录名称");
      default:
        return copy("Search directories or enter a path", "搜索目录或输入路径");
    }
  };

  // The bindings leave with these rows, so Enter can edit the conversation name on the members step.
  function DirectoryOptions() {
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
                  accessibilityLabel={title()}
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
            {copy("How do you want to add it?", "你想怎样添加目录？")}
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
              label={copy("Hidden folders", "隐藏文件夹")}
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
          when={
            kind() === "search" && query() && !loading() && rows().length > 0
          }
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
            {copy(
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
            {copy("Waiting for the machine…", "正在等待机器响应…")}
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
            {copy("No directories match this search.", "没有匹配的目录。")}
          </Label>
        </If>
        <If when={kind() === "github" && rows().length === 0 && !loading()}>
          <Label tone="muted" style={{ padding: 16 }}>
            {copy(
              "Paste a Git URL or enter owner/repo.",
              "粘贴 Git URL 或输入 owner/repo。",
            )}
          </Label>
        </If>
        <If when={cloneProgress()}>
          {(active) => (
            <View style={{ padding: 16, gap: 8 }}>
              <Label>
                {copy(
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
                label={copy("Cancel clone", "取消克隆")}
                disabled={cancelling() || !host.can("places.cancelClone")}
                onPress={() => void cancelClone()}
              />
            </View>
          )}
        </If>
      </>
    );
  }

  const methodEntry = () => methodStage() && flow().pages.length === 1;
  return (
    <Modal
      title={title()}
      phone={phone()}
      sheet={phone()}
      overPhoneNavigation={phone()}
      modalFocus
      blurBackdrop={props.layout === "desktop"}
      onClose={previous}
      width={560}
      height={
        phone()
          ? directory()
            ? "66%"
            : methodStage()
              ? "61.5%"
              : "82.8%"
          : 560
      }
      panelStyle={
        props.layout === "tablet" && windowSize().width >= 960
          ? { position: "absolute", right: 24, bottom: 38 }
          : undefined
      }
    >
      <If when={methodStage() || directory()}>
        <View
          style={{
            ...row,
            height: phone() ? 48 : 42,
            paddingHorizontal: 16,
            gap: 8,
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <Label size={11} tone="muted">
            {directory() ? "2/2" : "1/2"}
          </Label>
          <Label size={12} weight={600} style={grow}>
            {directory() ? uiText("members") : uiText("directory")}
          </Label>
          <Label size={11} tone="muted">
            {directory()
              ? copy("Last step", "最后一步")
              : copy("Next: Members", "下一步：成员")}
          </Label>
          <View
            style={{
              width: 7,
              height: 7,
              backgroundColor: directory() ? c().muted : c().ink,
            }}
          />
          <View
            style={{
              width: 7,
              height: 7,
              backgroundColor: directory() ? c().ink : c().surface,
              borderWidth: directory() ? 0 : 1,
              borderColor: c().border,
            }}
          />
        </View>
      </If>
      <Scroll style={grow} scrollbar={false}>
        <If when={directory()} else={<DirectoryOptions />}>
          {(target) => (
            <>
              <View
                style={{ ...row, gap: 8, marginHorizontal: 16, marginTop: 10 }}
              >
                <Icon name="folder" size={14} />
                <Label
                  size={12}
                  lines={1}
                >{`${target().name ?? host.projects().find((project) => project.id === target().projectId)?.name ?? target().display} · ${machineName()}`}</Label>
              </View>
              <Label
                tone="muted"
                size={14}
                style={{ paddingHorizontal: 16, paddingVertical: 7 }}
              >
                {copy(
                  "Who should work in this conversation?",
                  "谁来参与这次对话？",
                )}
              </Label>
              <Each of={host.agents()} key={(agent) => agent.id}>
                {(agent) => {
                  const checked = () => agents().includes(agent().id);
                  return (
                    <View
                      role="checkbox"
                      accessibilityLabel={agent().name}
                      accessibilityState={{ checked: checked() }}
                      onPress={() => toggleAgent(agent().id)}
                      hoverStyle={{ backgroundColor: c().selected }}
                      focusVisibleStyle={{
                        outlineWidth: 1,
                        outlineColor: c().blue,
                        outlineOffset: -1,
                      }}
                      style={{
                        ...row,
                        height: phone() ? 52 : 34,
                        gap: 12,
                        marginHorizontal: 16,
                        paddingHorizontal: 4,
                        borderBottomWidth: 1,
                        borderColor: c().border,
                        cursor: "pointer",
                      }}
                    >
                      <View
                        style={{
                          width: 13,
                          height: 13,
                          borderWidth: 1,
                          borderColor: checked() ? c().ink : c().strong,
                          backgroundColor: checked() ? c().button : c().canvas,
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <If when={checked()}>
                          <Icon name="check" tone="buttonInk" size={10} />
                        </If>
                      </View>
                      <AgentFace id={agent().id} size={24} />
                      <Label style={grow}>{agent().name}</Label>
                      <Label size={11} tone="muted">
                        {agent().runtime === "claude"
                          ? "Claude Code"
                          : agent().runtime === "codex"
                            ? "Codex"
                            : agent().runtime === "eta" || !agent().runtime
                              ? copy("eta (built-in)", "eta（内置）")
                              : agent().runtime}
                      </Label>
                    </View>
                  );
                }}
              </Each>
              <If when={!host.agents().length}>
                <Label tone="muted" style={{ padding: 16 }}>
                  {uiText("createAnAgentFirstInSettings")}
                </Label>
              </If>
              <If when={advanced()}>
                <View style={{ marginHorizontal: 16, marginTop: 14, gap: 10 }}>
                  <Field
                    label={uiText("conversationName")}
                    placeholder={uiText("conversationNameOptional")}
                    value={name()}
                    onChange={name.set}
                    onSubmit={() => void start()}
                  />
                  <View style={{ ...row, gap: 8 }}>
                    <Label size={12} tone="muted">
                      {uiText("steward2")}
                    </Label>
                    <ActionMenu
                      label={uiText("steward2")}
                      value={
                        currentSteward()
                          ? host.agent(currentSteward())?.name
                          : uiText("noSteward")
                      }
                    >
                      <Each of={agents()}>
                        {(id) => (
                          <ActionItem
                            label={host.agent(id())?.name ?? id()}
                            checked={currentSteward() === id()}
                            onSelect={() => steward.set(id())}
                          />
                        )}
                      </Each>
                      <ActionItem
                        label={uiText("noSteward")}
                        checked={currentSteward() === null}
                        onSelect={() => steward.set(null)}
                      />
                    </ActionMenu>
                  </View>
                </View>
              </If>
            </>
          )}
        </If>
        <If when={error()}>
          {(failure) => (
            <View role="alert" style={{ padding: 16, gap: 4 }}>
              <Label tone="red">{failureText(failure())}</Label>
              <If when={failure().detail && failure().code !== "other"}>
                <Label tone="muted" size={12}>
                  {failure().detail}
                </Label>
              </If>
            </View>
          )}
        </If>
      </Scroll>
      <If when={!phone() && !directory()}>
        <Label
          size={10}
          tone="muted"
          style={{
            paddingHorizontal: 16,
            paddingVertical: 5,
            borderTopWidth: 1,
            borderColor: c().border,
          }}
        >
          {copy(
            "↑↓ to move · Enter to choose · Esc to go back",
            "↑↓ 移动 · Enter 选择 · Esc 返回",
          )}
        </Label>
      </If>
      <View
        style={{
          ...row,
          height: 56,
          justifyContent: "flex-end",
          gap: 8,
          paddingHorizontal: 16,
          borderTopWidth: 1,
          borderColor: c().border,
        }}
      >
        <If when={directory()}>
          <Button
            label={copy("Conversation options", "对话选项")}
            icon="more"
            iconOnly
            tone="ghost"
            size={30}
            selected={advanced()}
            onPress={() => advanced.set(!advanced())}
            style={{ marginRight: "auto" }}
          />
        </If>
        <Button
          label={methodEntry() ? uiText("cancel") : uiText("back")}
          tone="ghost"
          size={30}
          disabled={busy() || saving() || cancelling()}
          onPress={previous}
        />
        <If when={directory()}>
          <Button
            label={copy("Start", "开始")}
            tone="primary"
            size={26}
            disabled={
              !agents().length || saving() || !host.can("conversations.create")
            }
            onPress={() => void start()}
          />
        </If>
      </View>
    </Modal>
  );
}
