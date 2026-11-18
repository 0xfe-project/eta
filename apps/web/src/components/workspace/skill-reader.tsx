import type { SkillDirectory, SkillFileContent } from "@eta/client-contracts";
import type { SkillResources } from "./skill-resources";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "@/components/markdown";
import { Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { skillCall } from "@/queries/skills";
import { skillErrorMessage } from "./skill-errors";
import { skillLink } from "./skill-resources";
import { CodeView } from "./transcript/code-view";

function LocalImage({
  resources,
  path,
  alt,
  reachable,
}: {
  resources: SkillResources;
  path: string;
  alt: string;
  reachable: boolean;
}) {
  const { t } = useTranslation("skills");
  const [failed, setFailed] = useState(false);
  const query = useQuery({
    queryKey: ["skill-image", resources.detail, path],
    queryFn: async () => {
      const content = await resources.read(path);
      if (content.kind !== "image") throw new Error("skill_files:not_image");
      return {
        url: resources.image(path, content),
        width: content.width,
        height: content.height,
      };
    },
    enabled: reachable,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  if (failed || query.error)
    return (
      <span role="alert">
        {failed ? t("imageFailed") : skillErrorMessage(query.error)}
      </span>
    );
  return query.data ? (
    <img
      src={query.data.url}
      alt={alt}
      className="max-w-full"
      onError={() => setFailed(true)}
      onLoad={(event) => {
        const image = event.currentTarget;
        if (
          image.naturalWidth * image.naturalHeight > 20_000_000 ||
          image.naturalWidth !== query.data.width ||
          image.naturalHeight !== query.data.height
        )
          setFailed(true);
      }}
    />
  ) : (
    <span role="status">{t("loading")}</span>
  );
}
function ExternalImage({ alt }: { alt: string }) {
  const { t } = useTranslation("skills");
  const [requested, setRequested] = useState(false);
  return (
    <span className="inline-flex flex-col gap-1 border p-2 text-xs">
      {alt}
      <Button size="sm" variant="outline" onClick={() => setRequested(true)}>
        {t("externalLoad")}
      </Button>
      {requested ? <span role="status">{t("externalRestricted")}</span> : null}
    </span>
  );
}

export function SkillBody({
  content,
  path,
  resources,
  reachable,
  navigate,
}: {
  content: SkillFileContent;
  path: string;
  resources: SkillResources;
  reachable: boolean;
  navigate: (path: string, anchor?: string) => void;
}) {
  const { t } = useTranslation("skills");
  if (content.kind === "unsupported")
    return (
      <p role="status">
        {t("unsupported", { reason: content.reason, size: content.size })}
      </p>
    );
  if (content.kind === "image")
    return (
      <LocalImage
        key={path}
        resources={resources}
        path={path}
        alt={path}
        reachable={reachable}
      />
    );
  if (path === "SKILL.md" && !content.preview && content.text.startsWith("---"))
    return (
      <pre className="whitespace-pre-wrap break-words text-xs">
        <code>{content.text}</code>
      </pre>
    );
  if (/\.md$/i.test(path))
    return (
      <>
        {content.preview?.metadata ? (
          <details className="mb-3 border-b pb-2 text-xs">
            <summary>{t("metadata")}</summary>
            <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">
              <code>{content.preview.metadata}</code>
            </pre>
          </details>
        ) : null}
        <Markdown
          resourceComponents={{
            a: ({ href, children }) => {
              const link = skillLink(path, href ?? "");
              if (link.kind === "blocked")
                return <span title={t("blocked")}>{children}</span>;
              if (link.kind === "external")
                return (
                  <a href={link.url} target="_blank" rel="noopener noreferrer">
                    {children}
                  </a>
                );
              return (
                <a
                  href={
                    link.anchor ? `#${encodeURIComponent(link.anchor)}` : "#"
                  }
                  onClick={(event) => {
                    event.preventDefault();
                    navigate(link.path, link.anchor);
                  }}
                >
                  {children}
                </a>
              );
            },
            img: ({ src, alt }) => {
              const link = skillLink(path, typeof src === "string" ? src : "");
              return link.kind === "blocked" ? (
                <span role="status">{t("blocked")}</span>
              ) : link.kind === "external" ? (
                <ExternalImage key={link.url} alt={alt ?? ""} />
              ) : (
                <LocalImage
                  key={link.path}
                  resources={resources}
                  path={link.path}
                  alt={alt ?? ""}
                  reachable={reachable}
                />
              );
            },
          }}
        >
          {content.preview?.body ?? content.text}
        </Markdown>
      </>
    );
  const lang = /\.json$/i.test(path)
    ? "json"
    : /\.(?:js|jsx|mjs|cjs)$/i.test(path)
      ? "js"
      : undefined;
  return (
    <pre className="whitespace-pre text-xs">
      {lang ? (
        <CodeView lang={lang} text={content.text} />
      ) : (
        <code>{content.text}</code>
      )}
    </pre>
  );
}

/** Each expanded directory owns one bounded, explicitly paged list. No recursive prefetch. */
function Directory({
  path,
  resources,
  reachable,
  select,
  selected,
  depth,
}: {
  path: string;
  resources: SkillResources;
  reachable: boolean;
  select: (path: string) => void;
  selected: string;
  depth: number;
}) {
  const { t } = useTranslation("skills");
  const [pages, setPages] = useState<SkillDirectory[]>([]);
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const load = useCallback(
    async (offset?: number) => {
      setBusy(true);
      setFailure(undefined);
      try {
        const { result } = await skillCall("directory", resources.target, {
          detail: resources.detail,
          path,
          ...(offset === undefined ? {} : { offset }),
        });
        setPages((current) =>
          offset === undefined ? [result] : [...current, result],
        );
      } catch (error) {
        setFailure(skillErrorMessage(error));
      } finally {
        setBusy(false);
      }
    },
    [resources, path],
  );
  useEffect(() => {
    if (reachable && !pages.length && !busy && !failure) void load();
  }, [reachable, pages.length, busy, failure, load]);
  const next = pages.at(-1)?.next;
  return (
    <ul className="space-y-1 pl-2 text-xs">
      {pages
        .flatMap((page) => page.entries)
        .map((entry) => {
          const child = path ? `${path}/${entry.path}` : entry.path;
          return (
            <li key={child}>
              <button
                className="block w-full break-all py-1 text-left hover:bg-muted aria-selected:bg-muted"
                type="button"
                aria-selected={selected === child}
                aria-expanded={
                  entry.kind === "directory" ? expanded.has(child) : undefined
                }
                disabled={
                  entry.kind === "blocked" ||
                  (entry.kind === "directory" && depth >= 8)
                }
                title={entry.reason ?? (depth >= 8 ? t("depth") : entry.kind)}
                onClick={() => {
                  if (entry.kind === "directory")
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (!next.delete(child)) next.add(child);
                      return next;
                    });
                  else select(child);
                }}
              >
                {entry.kind === "directory"
                  ? expanded.has(child)
                    ? "▾ "
                    : "▸ "
                  : ""}
                {entry.path}
                {entry.reason ? ` · ${entry.reason}` : ""}
              </button>
              {expanded.has(child) ? (
                <Directory
                  key={child}
                  path={child}
                  resources={resources}
                  reachable={reachable}
                  select={select}
                  selected={selected}
                  depth={depth + 1}
                />
              ) : null}
            </li>
          );
        })}
      {busy ? <Loading rows={1} /> : null}
      {failure ? (
        <li role="alert">
          {failure}
          <Button
            variant="ghost"
            size="sm"
            disabled={!reachable || busy}
            onClick={() => void load(next ?? undefined)}
          >
            {t("retry")}
          </Button>
        </li>
      ) : null}
      {next !== null && next !== undefined ? (
        <li>
          <Button
            size="sm"
            variant="ghost"
            disabled={!reachable || busy}
            onClick={() => void load(next)}
          >
            {t("more")}
          </Button>
        </li>
      ) : null}
    </ul>
  );
}
export function SkillTree(
  props: Omit<Parameters<typeof Directory>[0], "path" | "depth">,
) {
  return <Directory {...props} path="" depth={0} />;
}
