import type {
  FlowPage,
  MachineView,
  openFlow,
  PlaceFailure,
  PlaceListing,
  PlaceMatch,
  PlaceRef,
  PlacesAction,
  PlacesArgs,
  PlacesResults,
  RecentPlace,
} from "@eta/client-contracts";
import type { IconName } from "../../components/icons";
import type { useHost } from "../../services/host";
import {
  buildSuggestions,
  childDisplay,
  chooseMachine,
  chooseMethod,
  chooseRepo,
  machineOptions,
  manualRepoChoices,
  methodOptions,
  openBrowse,
  parentsOf,
  repoName,
  repoOptions,
} from "@eta/client-contracts";
import { localizedText, uiText } from "../../i18n";
import { failureText } from "./place-errors";

type Flow = ReturnType<typeof openFlow>;
type DirectoryTarget = PlaceRef & { projectId?: string | null; name?: string };

export interface ChoiceRow {
  id: string;
  label: string;
  detail?: string;
  icon: IconName;
  disabled?: boolean;
  select: () => void;
}

export function placeChoices(context: {
  page: () => FlowPage;
  capabilities: () => PlacesResults["capabilities"] | undefined;
  flow: { (): Flow; update: (update: (state: Flow) => Flow) => unknown };
  machine: () => MachineView | undefined;
  machineName: () => string;
  host: ReturnType<typeof useHost>;
  error: {
    (): PlaceFailure | undefined;
    set: (failure: PlaceFailure) => unknown;
  };
  matches: () => PlaceMatch[];
  query: () => string;
  listing: () => PlaceListing | undefined;
  repositories: () => PlacesResults["repos"] | undefined;
  choose: (id: string, place: DirectoryTarget) => void;
  perform: <T>(
    request: () => Promise<T>,
    done: (result: T) => void,
  ) => Promise<void>;
  place: <K extends PlacesAction>(
    operation: K,
    args: PlacesArgs[K],
  ) => Promise<PlacesResults[K]>;
  takeLocation: (page: FlowPage, target: DirectoryTarget) => void;
  recent: () => RecentPlace[];
}): ChoiceRow[] {
  const {
    page,
    capabilities,
    flow,
    machine,
    machineName,
    host,
    error,
    matches,
    query,
    listing,
    repositories,
    choose,
    perform,
    place,
    takeLocation,
    recent,
  } = context;
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
              ? localizedText(
                  "Directory browsing requires the Eta daemon",
                  "浏览目录需要 Eta 守护进程",
                )
              : closed === "offline"
                ? localizedText("Offline", "离线")
                : undefined,
          select: () => flow.update((state) => chooseMachine(state, entry.id)),
        }),
      );
    case "method": {
      const descriptions = {
        search: [
          uiText("searchDirectories"),
          localizedText(
            `Find a directory on ${machineName()}`,
            `在 ${machineName()} 上查找目录`,
          ),
          "search",
          "places.resolve",
        ],
        browse: [
          localizedText("Browse…", "浏览…"),
          localizedText(
            "Walk the folders one level at a time",
            "逐级浏览文件夹",
          ),
          "folder",
          "places.list",
        ],
        github: [
          localizedText("Clone from GitHub", "从 GitHub 克隆"),
          localizedText(
            "Find a repository or paste its URL",
            "查找仓库或粘贴 URL",
          ),
          "download",
          "places.clone",
        ],
        new: [
          localizedText("New directory", "新建目录"),
          localizedText("Make an empty directory", "创建一个空目录"),
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
              ? localizedText(
                  "Checking machine capabilities…",
                  "正在检查机器能力…",
                )
              : note === "no_git"
                ? failureText({ code: "no_git" })
                : note === "update"
                  ? localizedText(
                      "Update the Eta daemon to create directories",
                      "更新 Eta 守护进程后可创建目录",
                    )
                  : note === "paste_only"
                    ? localizedText(
                        "gh is not signed in: paste a URL or owner/repo",
                        "gh 未登录：粘贴 URL 或 owner/repo",
                      )
                    : detail,
          select: () =>
            flow.update((state) => chooseMethod(state, current.machineId, id)),
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
            detail: localizedText("Open this path", "打开此路径"),
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
            ? localizedText(
                `Inside ${target.display}`,
                `位于 ${target.display}`,
              )
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
              label: localizedText("Create directory", "创建目录"),
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
}
