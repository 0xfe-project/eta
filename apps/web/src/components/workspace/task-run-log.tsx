import type { RefObject } from "react";
import type { LogBlock, ToolGroup } from "@/lib/run";
import type { TaskRun } from "@/queries/tasks";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "@/components/markdown";
import { Loading } from "@/components/states";
import { groupBlocks } from "@/lib/run";
import { useSessionLog } from "@/queries/sessions";
import { isActive } from "./task-format";
import { ImageStrip } from "./transcript/image-strip";
import { ThinkingBlock } from "./transcript/thinking-block";
import { ToolDetailCard } from "./transcript/tool-detail";

/**
 * A run's log: its session's transcript, live while the run works. There is no second record of
 * what the executor did; this is the session drawn the way a conversation draws a reply.
 *
 * `scrollRef` is the box the log scrolls in. While the run works the log follows its newest step,
 * unless the reader scrolled up, and follows again back at the bottom; a finished run opens at its
 * start, because it is read as a story. Scrolling to the top brings the older part of a session
 * longer than the view keeps.
 */
export function RunLog({
  run,
  scrollRef,
}: {
  run: TaskRun;
  scrollRef?: RefObject<HTMLDivElement | null>;
}) {
  const { t: translateText } = useTranslation(["tasks", "chat"] as const);
  const log = useSessionLog(run.sessionId);
  const { blocks } = log;
  const items = useMemo(
    () => (blocks === undefined ? undefined : groupBlocks(blocks)),
    [blocks],
  );
  const active = isActive(run.status);
  useFollow(scrollRef, active, items);
  if (run.sessionId === null)
    return (
      <p className="text-xs text-muted-foreground">
        {translateText("log.empty")}
      </p>
    );
  if (items === undefined)
    return active || run.status === "completed" ? (
      <Loading layout="lines" label={translateText("log.loading")} />
    ) : (
      <p className="text-xs text-muted-foreground">
        {translateText("log.empty")}
      </p>
    );
  if (items.length === 0)
    return (
      <p className="text-xs text-muted-foreground">
        {translateText("log.empty")}
      </p>
    );
  const statusLabels = {
    running: translateText("runStatus.running"),
    completed: translateText("log.done"),
    failed: translateText("log.failed"),
  };
  const card = (block: Extract<LogBlock, { type: "tool" }>) => (
    <ToolDetailCard
      block={block}
      sessionId={run.sessionId}
      progress={log.progress.get(block.id)}
      statusLabel={statusLabels[block.status]}
    />
  );
  return (
    <>
      {log.earlier ? (
        <Earlier
          scrollRef={scrollRef}
          loading={log.loadingEarlier}
          onLoad={log.loadEarlier}
        />
      ) : null}
      <ol
        aria-label={translateText("log.title")}
        className="run-log space-y-2 border-l pl-3 text-xs"
      >
        {items.map((item) => (
          <li key={item.id} className="min-w-0">
            {item.type === "thinking" ? (
              <ThinkingBlock text={item.text} />
            ) : item.type === "text" ? (
              <Markdown className="text-xs">{item.text}</Markdown>
            ) : item.type === "user" ? (
              <>
                {item.text === "" ? null : (
                  <p className="whitespace-pre-wrap text-muted-foreground wrap-anywhere">
                    {item.text}
                  </p>
                )}
                {item.images === undefined ? null : (
                  <ImageStrip sessionId={run.sessionId} images={item.images} />
                )}
              </>
            ) : item.type === "error" ? (
              <p className="log-error" role="note">
                <span className="log-error-label">
                  {item.aborted
                    ? translateText("log.aborted")
                    : translateText("log.error")}
                </span>
                {item.text}
              </p>
            ) : item.type === "summary" ? (
              <details className="log-summary">
                <summary>
                  {item.kind === "compaction"
                    ? translateText("log.compacted")
                    : translateText("log.branched")}
                </summary>
                <Markdown className="text-xs">{item.text}</Markdown>
              </details>
            ) : item.type === "group" ? (
              <Group group={item} statusLabel={statusLabels}>
                {item.tools.map((tool) => (
                  <li key={tool.id} className="min-w-0">
                    {card(tool)}
                  </li>
                ))}
              </Group>
            ) : (
              card(item)
            )}
          </li>
        ))}
      </ol>
    </>
  );
}

/** A run of calls to one tool, folded to one line that says how many and opens to them. */
function Group({
  group,
  statusLabel,
  children,
}: {
  group: ToolGroup;
  statusLabel: { failed: string };
  children: React.ReactNode;
}) {
  const { t: translateText } = useTranslation(["tasks"] as const);
  const failed = group.tools.filter((tool) => tool.status === "failed").length;
  return (
    <details className="tool-group">
      <summary className="tool-card-head">
        <span className="tool-card-label">
          {translateText("log.group", {
            name: group.name,
            count: group.tools.length,
          })}
        </span>
        {failed === 0 ? null : (
          <span className="tool-card-status failed">
            {failed} {statusLabel.failed}
          </span>
        )}
      </summary>
      <ol className="tool-group-body space-y-2">{children}</ol>
    </details>
  );
}

/**
 * Where the older part of the session starts: reaching it asks for the page before, and the
 * button is there for whoever would rather ask.
 */
function Earlier({
  scrollRef,
  loading,
  onLoad,
}: {
  scrollRef: RefObject<HTMLDivElement | null> | undefined;
  loading: boolean;
  onLoad: () => void;
}) {
  const { t: translateText } = useTranslation(["tasks"] as const);
  const ref = useRef<HTMLButtonElement>(null);
  const loadRef = useRef(onLoad);
  useLayoutEffect(() => {
    loadRef.current = onLoad;
  });
  useEffect(() => {
    const button = ref.current;
    if (button === null || typeof IntersectionObserver === "undefined")
      return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        // Only a reader who went up there: a working run opens at its bottom, with this out of
        // sight until they scroll.
        const box = scrollRef?.current;
        if (
          entries.some((entry) => entry.isIntersecting) &&
          (box === null ||
            box === undefined ||
            box.scrollTop < box.clientHeight)
        )
          loadRef.current();
      },
      { root: scrollRef?.current ?? null, rootMargin: "200px 0px 0px 0px" },
    );
    observer.observe(button);
    return () => observer.disconnect();
  }, [scrollRef]);
  return (
    <button
      ref={ref}
      type="button"
      className="log-earlier"
      disabled={loading}
      onClick={onLoad}
    >
      {loading
        ? translateText("log.loadingEarlier")
        : translateText("log.earlier")}
    </button>
  );
}

/**
 * Keep a working run's newest step in view: glued to the bottom until the reader scrolls up, and
 * glued again once they are back (the same 16px slack as the group process box). When older rows
 * come in above, the reader stays on what they were reading rather than jumping by a page.
 */
function useFollow(
  scrollRef: RefObject<HTMLDivElement | null> | undefined,
  active: boolean,
  items: readonly { id: string }[] | undefined,
) {
  const pinnedRef = useRef(active);
  const beforeRef = useRef<{ first: string | undefined; height: number }>({
    first: undefined,
    height: 0,
  });
  useEffect(() => {
    const box = scrollRef?.current;
    if (box === null || box === undefined) return undefined;
    const onScroll = () => {
      pinnedRef.current =
        box.scrollHeight - box.scrollTop - box.clientHeight < 16;
    };
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => box.removeEventListener("scroll", onScroll);
  }, [scrollRef]);
  useLayoutEffect(() => {
    const box = scrollRef?.current;
    if (box === null || box === undefined || items === undefined) return;
    const first = items[0]?.id;
    const was = beforeRef.current;
    if (was.first !== undefined && first !== was.first && !pinnedRef.current)
      box.scrollTop += box.scrollHeight - was.height;
    if (active && pinnedRef.current) box.scrollTop = box.scrollHeight;
    beforeRef.current = { first, height: box.scrollHeight };
  }, [scrollRef, active, items]);
}
