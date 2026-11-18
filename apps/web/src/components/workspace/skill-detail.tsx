import type { SkillTarget } from "@eta/client-contracts";
import type { ReactNode } from "react";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/ArrowsClockwise";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { LoadError, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { skillCall } from "@/queries/skills";
import { skillErrorMessage } from "./skill-errors";
import { SkillBody, SkillTree } from "./skill-reader";
import { SkillResources } from "./skill-resources";

export function SkillDetail({
  target,
  skill,
  reachable,
  onBack,
  onReload,
  crumbs,
  status,
}: {
  target: SkillTarget;
  skill: string;
  reachable: boolean;
  onBack: () => void;
  onReload: () => void;
  crumbs: string[];
  status: ReactNode;
}) {
  const { t } = useTranslation("skills");
  const instanceId = useId();
  const opened = useQuery({
    queryKey: ["skill-open", target, skill, instanceId],
    queryFn: async ({ signal }) => {
      const resolved = await skillCall("list", target, {});
      if (signal.aborted) throw signal.reason;
      if (
        resolved.target.home !== target.home ||
        resolved.target.projectPath !== target.projectPath
      )
        throw new Error("skill_files:target_moved");
      const response = await skillCall("open", resolved.target, { skill });
      if (signal.aborted) {
        await skillCall("close", response.target, {
          detail: response.result.detail,
        });
        throw new Error("skill_files:detail_expired");
      }
      return response;
    },
    enabled: reachable,
    retry: false,
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [file, setFile] = useState("SKILL.md");
  const [anchor, setAnchor] = useState("");
  const [treeOpen, setTreeOpen] = useState(false);
  const resources = useMemo(
    () =>
      opened.data
        ? new SkillResources(opened.data.target, opened.data.result.detail)
        : undefined,
    [opened.data],
  );
  const bodyRef = useRef<HTMLDivElement>(null);
  // StrictMode re-attaches the same resource before this microtask runs.
  const attachedRef = useRef<SkillResources | undefined>(undefined);
  useEffect(() => {
    attachedRef.current = resources;
    return () => {
      attachedRef.current = undefined;
      queueMicrotask(() => {
        if (resources && attachedRef.current !== resources)
          void resources
            .dispose()
            .catch((error) => toast.error(skillErrorMessage(error)));
      });
    };
  }, [resources]);
  const read = useQuery({
    queryKey: ["skill-file", resources?.detail, file],
    queryFn: () => resources!.read(file),
    enabled: reachable && !!resources,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  useEffect(() => {
    if (!anchor || !read.data) return;
    // Streamdown may supply heading ids; fall back to exact heading text within this body only.
    const match = [
      ...(bodyRef.current?.querySelectorAll<HTMLElement>(
        "[id],h1,h2,h3,h4,h5,h6",
      ) ?? []),
    ].find(
      (element) =>
        element.id === anchor ||
        element.textContent === anchor ||
        element.textContent?.toLowerCase().replace(/\s+/g, "-") === anchor,
    );
    match?.scrollIntoView?.({ block: "start" });
  }, [anchor, read.data]);
  const navigate = (path: string, hash = "") => {
    setFile(path);
    setAnchor(hash);
    setTreeOpen(false);
  };
  const current = read.data;
  const diagnostics = new Set([
    ...(opened.data?.result.diagnostics ?? []),
    ...(current?.kind === "text" ? current.diagnostics : []),
  ]);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-skill-detail>
      <Button
        className="shrink-0 self-start"
        size="sm"
        variant="ghost"
        onClick={onBack}
      >
        {t("back")}
      </Button>
      <div className="flex shrink-0 items-start gap-1">
        <nav
          aria-label={t("breadcrumb")}
          className="min-w-0 py-1 text-xs text-muted-foreground"
        >
          <ol className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
            {crumbs.map((crumb, index) => (
              <li key={index} className="min-w-0 wrap-anywhere">
                {index > 0 ? (
                  <span aria-hidden="true" className="mr-1.5">
                    /
                  </span>
                ) : null}
                {crumb}
              </li>
            ))}
            <li
              aria-current="page"
              className="min-w-0 font-semibold wrap-anywhere text-foreground"
            >
              <span
                aria-hidden="true"
                className="mr-1.5 font-normal text-muted-foreground"
              >
                /
              </span>
              {skill}
            </li>
          </ol>
        </nav>
        <Button
          size="icon-sm"
          variant="ghost"
          className="-mt-0.5 shrink-0"
          aria-label={t("refresh")}
          title={t("refresh")}
          onClick={onReload}
          disabled={!reachable}
        >
          <ArrowsClockwiseIcon aria-hidden="true" />
        </Button>
      </div>
      {status ? (
        <div className="text-xs text-muted-foreground">{status}</div>
      ) : null}
      {opened.data ? (
        <Button
          className="shrink-0 self-start sm:hidden"
          size="sm"
          variant="outline"
          aria-expanded={treeOpen}
          onClick={() => setTreeOpen(!treeOpen)}
        >
          {t("files")}
        </Button>
      ) : null}
      {opened.error ? (
        <LoadError
          what={skill}
          error={new Error(skillErrorMessage(opened.error))}
        />
      ) : !opened.data || !resources ? (
        reachable ? (
          <Loading rows={3} />
        ) : null
      ) : (
        <>
          {diagnostics.size ? (
            <ul
              className="max-h-[20dvh] shrink-0 space-y-1 overflow-auto"
              aria-label={t("diagnostics")}
            >
              {[...diagnostics].map((message) => (
                <li
                  className="text-xs wrap-anywhere text-destructive"
                  key={message}
                >
                  {message}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex min-h-0 flex-1 overflow-hidden border">
            <nav
              aria-label={t("tree")}
              className={`${treeOpen ? "block w-full sm:w-40" : "hidden w-40 sm:block"} shrink-0 overflow-auto border-r p-1`}
            >
              <SkillTree
                resources={resources}
                reachable={reachable}
                select={navigate}
                selected={file}
              />
            </nav>
            <div
              key={file}
              ref={bodyRef}
              data-skill-content
              role="region"
              aria-label={file}
              tabIndex={0}
              className={`${treeOpen ? "hidden sm:block" : "block"} min-w-0 flex-1 overflow-auto p-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring`}
            >
              {read.error ? (
                <>
                  <LoadError
                    what={file}
                    error={new Error(skillErrorMessage(read.error))}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!reachable}
                    onClick={() => {
                      resources.forget(file);
                      void read.refetch();
                    }}
                  >
                    {t("retry")}
                  </Button>
                </>
              ) : !current ? (
                <Loading rows={3} />
              ) : (
                <SkillBody
                  content={current}
                  path={file}
                  resources={resources}
                  reachable={reachable}
                  navigate={navigate}
                />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
