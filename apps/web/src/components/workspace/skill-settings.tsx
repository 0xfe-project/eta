import type { SkillTarget } from "@eta/client-contracts";
import type { ReactNode } from "react";
import type { SkillDetailSearch, SkillSearch } from "./skill-route";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/ArrowsClockwise";
import { BookOpenIcon } from "@phosphor-icons/react/BookOpen";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Empty, LoadError, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useMachines, useProjects } from "@/queries/projects";
import { skillCall } from "@/queries/skills";
import { useWireState } from "@/queries/wire";
import { PageHeader } from "./app-shell";
import { machineName, skillMachines } from "./machine-choice";
import { PluginsCategory } from "./plugins-category";
import { Select, SelectOption } from "./select-field";
import { SkillDetail } from "./skill-detail";
import { skillErrorMessage } from "./skill-errors";

function useSkillTarget(search: SkillSearch) {
  const { t } = useTranslation(["skills", "machines"] as const);
  const { machines, loaded, error } = useMachines();
  const {
    projects,
    loaded: projectsLoaded,
    error: projectsError,
  } = useProjects();
  const connected = useWireState((state) => state.status === "open");
  const listed = skillMachines(machines);
  const machine = listed.find((item) => item.id === search.device);
  const scope = search.scope ?? "personal";
  const eligibleProjects = projects.filter(
    (item) => item.machineId === search.device && !item.archived,
  );
  const project = eligibleProjects.find((item) => item.id === search.project);
  const home = machine?.home;
  let status: ReactNode;
  let selectionNeeded: "chooseMachine" | "chooseProject" | undefined;
  if (!connected) status = <p role="status">{t("disconnected")}</p>;
  else if (error) status = <LoadError what={t("device")} error={error} />;
  else if (!loaded) status = <Loading rows={2} />;
  else if (!search.device) {
    if (listed.length) selectionNeeded = "chooseMachine";
    status = <p role="status">{t(selectionNeeded ?? "noMachines")}</p>;
  } else if (!machine)
    status = <p role="status">{t("removed", { id: search.device })}</p>;
  else if (machine.status !== "online")
    status = (
      <p role="status">
        {t("offline", { status: t(`machines:status.${machine.status}`) })}
      </p>
    );
  else if (!home) status = <p role="status">{t("homeUnknown")}</p>;
  else if (scope === "project") {
    if (projectsError)
      status = <LoadError what={t("projectLabel")} error={projectsError} />;
    else if (!projectsLoaded) status = <Loading rows={1} />;
    else if (!project) {
      if (!search.project) selectionNeeded = "chooseProject";
      status = <p role="status">{t(selectionNeeded ?? "projectGone")}</p>;
    }
  }
  const target: SkillTarget | undefined =
    machine && home && (scope === "personal" || project)
      ? {
          machineId: machine.id,
          home,
          scope,
          ...(scope === "project" && project
            ? { projectId: project.id, projectPath: project.path }
            : {}),
        }
      : undefined;
  return {
    listed,
    eligibleProjects,
    loaded,
    machine,
    project,
    target,
    reachable: !status && !!target,
    status,
    selectionNeeded,
  };
}

function SkillListEmpty({
  title,
  children,
}: {
  title: string;
  children: string;
}) {
  return (
    <div role="status" data-skill-empty>
      <Empty icon={BookOpenIcon} title={title}>
        {children}
      </Empty>
    </div>
  );
}

export function SkillSettings({
  search,
  onSearch,
}: {
  search: SkillSearch;
  onSearch: (next: Partial<SkillSearch>) => void;
}) {
  const { t } = useTranslation(["skills", "machines", "plugins"] as const);
  const {
    listed,
    eligibleProjects,
    loaded,
    project,
    target,
    reachable,
    status,
    selectionNeeded,
  } = useSkillTarget(search);
  const scope = search.scope ?? "personal";
  const list = useInfiniteQuery({
    queryKey: ["skill-list", target],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      skillCall("list", target!, { offset: pageParam }),
    getNextPageParam: (last) => last.result.next ?? undefined,
    enabled: reachable,
    retry: false,
  });
  const first = list.data?.pages[0];
  const entries = list.data?.pages.flatMap((page) => page.result.entries) ?? [];
  // Keep typing responsive while the router commits each replace to the address.
  const [filter, setFilter] = useState(search.q ?? "");
  useEffect(() => {
    if (filter === (search.q ?? "")) return;
    const timer = window.setTimeout(onSearch, 180, { q: filter || undefined });
    return () => window.clearTimeout(timer);
  }, [filter, onSearch, search.q]);
  const query = filter.toLowerCase();
  const filtered = entries.filter((entry) =>
    [entry.name, entry.path, entry.description].some((text) =>
      text.toLowerCase().includes(query),
    ),
  );
  return (
    <>
      <PageHeader title={t("plugins:title")}>
        <div className="flex min-w-0 items-center gap-1" data-skill-toolbar>
          <Select
            aria-label={t("device")}
            size="sm"
            className="w-44 max-w-[48vw] text-xs"
            value={search.device ?? ""}
            disabled={!loaded || !listed.length}
            onValueChange={(device) => onSearch({ device, project: undefined })}
          >
            <SelectOption value="">{t("chooseMachine")}</SelectOption>
            {listed.map((item) => (
              <SelectOption key={item.id} value={item.id}>
                <span title={machineName(item, t("primarySuffix"))}>
                  {machineName(item, t("primarySuffix"))}
                  {item.status !== "online"
                    ? ` · ${t(`machines:status.${item.status}`)}`
                    : ""}
                </span>
              </SelectOption>
            ))}
          </Select>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("refresh")}
            title={t("refresh")}
            disabled={!reachable || list.isFetching}
            onClick={() => void list.refetch()}
          >
            <ArrowsClockwiseIcon aria-hidden="true" />
          </Button>
        </div>
      </PageHeader>
      <main
        id="main"
        className="min-h-0 min-w-0 flex-1 overflow-y-auto"
        data-skill-list
      >
        <div className="@container mx-auto max-w-[96rem] space-y-3 px-4 py-4 sm:px-6">
          <PluginsCategory
            skills
            search={{ ...search, q: filter || undefined }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Tabs
              value={scope}
              onValueChange={(next) =>
                onSearch({
                  scope: next === "project" ? "project" : undefined,
                  project: undefined,
                })
              }
            >
              <TabsList aria-label={t("title")}>
                <TabsTrigger value="personal">{t("personal")}</TabsTrigger>
                <TabsTrigger value="project">{t("project")}</TabsTrigger>
              </TabsList>
            </Tabs>
            {scope === "project" ? (
              <Select
                aria-label={t("projectLabel")}
                size="sm"
                className="w-44 max-w-full"
                title={
                  project ? `${project.name} · ${project.path}` : undefined
                }
                value={search.project ?? ""}
                disabled={!search.device}
                onValueChange={(project) => onSearch({ project })}
              >
                <SelectOption value="">{t("chooseProject")}</SelectOption>
                {eligibleProjects.map((item) => (
                  <SelectOption key={item.id} value={item.id}>
                    {item.name} · {item.path}
                  </SelectOption>
                ))}
              </Select>
            ) : null}
          </div>
          <form
            className="relative w-64 max-w-full"
            onSubmit={(event) => {
              event.preventDefault();
              onSearch({ q: filter || undefined });
            }}
          >
            <Input
              aria-label={t("search")}
              placeholder={t("search")}
              className="h-8 pr-9"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <Button
              type="submit"
              size="icon-sm"
              variant="ghost"
              className="absolute top-0.5 right-0.5"
              aria-label={t("search")}
              title={t("search")}
            >
              <MagnifyingGlassIcon aria-hidden="true" />
            </Button>
          </form>
          {selectionNeeded ? (
            <SkillListEmpty title={t(selectionNeeded)}>
              {t(`${selectionNeeded}Hint`)}
            </SkillListEmpty>
          ) : status ? (
            <div className="text-sm text-muted-foreground">{status}</div>
          ) : null}
          {!reachable ? null : list.error ? (
            <LoadError
              what={t("title")}
              error={new Error(skillErrorMessage(list.error))}
            />
          ) : !first ? (
            <Loading rows={3} />
          ) : !first.result.exists ? (
            <SkillListEmpty title={t("missing")}>
              {t("missingHint")}
            </SkillListEmpty>
          ) : (
            <>
              {!filtered.length ? (
                <SkillListEmpty
                  title={t(entries.length ? "noResults" : "empty")}
                >
                  {t(
                    entries.length
                      ? list.hasNextPage
                        ? "noResultsMoreHint"
                        : "noResultsHint"
                      : "emptyHint",
                  )}
                </SkillListEmpty>
              ) : (
                <ul
                  data-skill-grid
                  className="grid grid-cols-1 gap-3 @min-[30rem]:grid-cols-2 @min-[41rem]:grid-cols-3 @min-[54rem]:grid-cols-4"
                >
                  {filtered.map((entry) => (
                    <li key={entry.path} className="min-w-0">
                      {entry.kind === "directory" ? (
                        <Link
                          to="/plugins/skills/detail"
                          search={{
                            ...search,
                            q: filter || undefined,
                            skill: entry.path,
                            home: first.target.home,
                            projectPath: first.target.projectPath,
                          }}
                          className="block space-y-1 border p-3 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                          title={entry.path}
                        >
                          <h2
                            className="truncate font-medium"
                            title={entry.name}
                          >
                            {entry.name}
                          </h2>
                          <p className="line-clamp-2 h-[2lh] wrap-anywhere text-xs text-muted-foreground">
                            {entry.description}
                          </p>
                        </Link>
                      ) : (
                        <div
                          className="space-y-1 border p-3 text-sm"
                          title={entry.reason}
                        >
                          <h2
                            className="truncate font-medium"
                            title={entry.name}
                          >
                            {entry.name}
                          </h2>
                          <p className="line-clamp-2 h-[2lh] wrap-anywhere text-xs text-muted-foreground">
                            {entry.description || entry.reason}
                          </p>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {list.hasNextPage ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={list.isFetching}
                  onClick={() => void list.fetchNextPage()}
                >
                  {t("more")}
                </Button>
              ) : null}
            </>
          )}
        </div>
      </main>
    </>
  );
}

export function SkillDetailPage({
  search,
  onBack,
}: {
  search: SkillDetailSearch;
  onBack: () => void;
}) {
  const { t } = useTranslation(["skills", "plugins"] as const);
  const { machine, project, target, reachable, status } =
    useSkillTarget(search);
  const [revision, setRevision] = useState(0);
  const { skill, home, projectPath, device, scope } = search;
  // This is only presentation/target matching. The server still revalidates roots,
  // the daemon epoch, access and the requested path before opening or writing.
  const valid =
    !!device &&
    !!home &&
    !!skill &&
    !/[/\\]/.test(skill) &&
    ![...skill].some((char) => char.charCodeAt(0) < 32) &&
    skill !== "." &&
    skill !== ".." &&
    (scope !== "project" || (!!search.project && !!projectPath));
  const moved =
    target !== undefined &&
    (target.home !== home || target.projectPath !== projectPath);
  const linkedTarget: SkillTarget | undefined = valid
    ? {
        machineId: device,
        home,
        scope: scope ?? "personal",
        ...(scope === "project"
          ? { projectId: search.project, projectPath }
          : {}),
      }
    : undefined;
  const canOpen = reachable && !moved;
  return (
    <>
      <PageHeader title={t("plugins:title")} />
      <main
        id="main"
        className="mx-auto flex min-h-0 w-full max-w-[96rem] min-w-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4 sm:px-6"
      >
        <PluginsCategory skills search={search} />
        {linkedTarget && skill ? (
          <SkillDetail
            key={JSON.stringify([linkedTarget, skill, revision])}
            target={linkedTarget}
            skill={skill}
            reachable={canOpen}
            crumbs={[
              machine
                ? machineName(machine, t("primarySuffix"))
                : linkedTarget.machineId,
              t(scope ?? "personal"),
              ...(scope === "project"
                ? [project?.name ?? search.project!]
                : []),
            ]}
            status={moved ? <p role="alert">{t("targetMoved")}</p> : status}
            onBack={onBack}
            onReload={() => setRevision((n) => n + 1)}
          />
        ) : (
          <>
            <Button
              className="self-start"
              size="sm"
              variant="outline"
              onClick={onBack}
            >
              {t("back")}
            </Button>
            <p role="alert" className="text-sm">
              {t("invalidLink")}
            </p>
          </>
        )}
      </main>
    </>
  );
}
