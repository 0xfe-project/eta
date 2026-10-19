import type { ViewDiagnostics } from "@eta/client-contracts";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSessionView } from "@/queries/sessions";

/**
 * What a member's session is running, behind one button: the system prompt it will send, block by
 * block, and the tools it can call.
 *
 * The point of the panel is the words, not their measurements. The harness composes the prompt and
 * sends its whole text over with it, so a panel that draws only each block's length is a ruler
 * standing in for a reader. Every block is a fold onto its own text and every tool onto its
 * description, folded by default: the list of blocks and their sizes is the answer most questions
 * want, and the rest is one click away.
 */
export function InspectButton({
  sessionId,
  name,
}: {
  sessionId: string;
  /** Who the session belongs to; a bare id is not something a reader can place. */
  name?: string;
}) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="xs"
        variant="outline"
        onClick={() => setOpen(true)}
        title={translateText("chat:panel.inspect")}
      >
        {translateText("chat:panel.inspect")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {/* `sm:` because the dialog's own base sets `sm:max-w-sm`, and a variant is not beaten by
            a plain class: without the prefix this panel stays 24rem wide on a desktop, and a
            prompt block is not readable in 24rem. */}
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-sm">{name ?? sessionId}</DialogTitle>
            {name === undefined ? null : (
              <p className="font-mono text-[10px] break-all text-faint">
                {sessionId}
              </p>
            )}
          </DialogHeader>
          {/* The read sits here rather than in each section: one subscription, one state machine,
              and the two panels cannot disagree about whether this session exists. */}
          {open ? <InspectBody sessionId={sessionId} /> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * The dialog's contents, with its three states kept apart. A view that has not arrived is still
 * being read; a view with no `prompt` section is a session that has not composed one yet; only a
 * refused `resync` is an error. Drawing the first two as an error is how a panel loses the right
 * to be believed when it reports a real one.
 */
function InspectBody({ sessionId }: { sessionId: string }) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  const { view, status } = useSessionView(sessionId);
  if (status === "loading") {
    return (
      <p className="text-xs text-muted-foreground">
        {translateText("common:states.reading")}
      </p>
    );
  }
  if (status === "error") {
    return (
      <p className="text-xs text-muted-foreground">
        {translateText("chat:panel.readFailed")}
      </p>
    );
  }
  return (
    <div className="min-w-0 space-y-4">
      <PromptSection prompt={view?.prompt} />
      <ToolsSection tools={view?.tools} />
    </div>
  );
}

/** One prompt block as the fold wants it: a name, which half of the cache it belongs to, its text. */
interface BlockRow {
  name: string;
  stable: boolean;
  text: string;
}

/**
 * Keys for a list whose names arrive from another process and may repeat or be missing: the name
 * itself, and which one of them this is when a host sends the same name twice. A position number
 * alone would move an open fold onto another block as soon as one is added.
 */
function keyMaker() {
  const seen = new Map<string, number>();
  return (name: string) => {
    const nth = (seen.get(name) ?? 0) + 1;
    seen.set(name, nth);
    return nth === 1 ? name : `${name}#${nth}`;
  };
}

function PromptSection({ prompt }: { prompt: ViewDiagnostics | undefined }) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  // The blocks cross a process boundary to get here, so the shape is checked and not assumed: a
  // host older than this page should leave an empty list, not a blank screen.
  const blocks: BlockRow[] = (
    Array.isArray(prompt?.sections) ? prompt.sections : []
  )
    .filter((section) => section !== null && typeof section === "object")
    .map((section) => ({
      name: typeof section.name === "string" ? section.name : "?",
      stable: section.stable === true,
      text: typeof section.text === "string" ? section.text : "",
    }));
  const keyOf = keyMaker();
  return (
    <section>
      <h3 className="mb-1 font-mono text-[10px] tracking-[0.12em] text-faint uppercase">
        {translateText("chat:panel.prompt")}
      </h3>
      <p className="font-mono text-[11px] text-muted-foreground tabular-nums">
        {prompt === undefined
          ? translateText("chat:panel.promptEmpty")
          : `stable ${prompt.stableChars} / adaptive ${prompt.adaptiveChars} · ${translateText("chat:panel.blockCount", { total: blocks.length })}`}
      </p>
      <ul className="mt-1">
        {blocks.map((block) => (
          <FoldRow
            key={keyOf(block.name)}
            label={block.name}
            meta={`${block.stable ? "stable" : "adaptive"} · ${block.text.length}`}
            body={block.text}
          />
        ))}
      </ul>
    </section>
  );
}

function ToolsSection({
  tools,
}: {
  tools: { name: string; description: string }[] | undefined;
}) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  const list = Array.isArray(tools) ? tools : [];
  const keyOf = keyMaker();
  return (
    <section>
      <h3 className="mb-1 font-mono text-[10px] tracking-[0.12em] text-faint uppercase">
        {translateText("chat:panel.tools")}
      </h3>
      <p className="font-mono text-[11px] text-muted-foreground tabular-nums">
        {translateText("chat:panel.toolCount", { total: list.length })}
      </p>
      <ul className="mt-1">
        {list.map((tool) => {
          const name = typeof tool?.name === "string" ? tool.name : "?";
          const description =
            typeof tool?.description === "string" ? tool.description : "";
          // The first line says what the tool is for and sits in the header, where it is clipped.
          // Every description that has any text gets a fold onto the whole of it: most descriptions
          // here are one long line, so the header alone is a half-sentence with nothing behind it,
          // and the body is also the only place the copy button lives.
          const brief = (description.split("\n")[0] ?? "").trim();
          const full = description.trim();
          return (
            <FoldRow
              key={keyOf(name)}
              label={name}
              brief={brief}
              body={full.length > 0 ? full : undefined}
            />
          );
        })}
      </ul>
    </section>
  );
}

/**
 * One row: a header that says what it is and how big it is, and — where there is more to read — a
 * fold onto the text, with a copy button. A prompt block and a tool take the same shape, because
 * both are a name, a measure, and a body of prose.
 */
function FoldRow({
  label,
  meta,
  brief,
  body,
}: {
  label: string;
  meta?: string;
  brief?: string;
  body?: string;
}) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const id = setTimeout(setCopied, 2500, false);
    return () => clearTimeout(id);
  }, [copied]);
  const hasBody = body !== undefined && body.length > 0;
  const copyLabel = copied
    ? translateText("common:feedback.copied")
    : translateText("common:actions.copy");
  const head = (
    <>
      {hasBody ? (
        <span
          aria-hidden="true"
          className="shrink-0 text-[8px] text-faint transition-transform duration-[60ms] ease-linear group-open/fold:rotate-90 motion-reduce:transition-none"
        >
          ▶
        </span>
      ) : null}
      <span className="min-w-0 shrink truncate font-mono text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate">{brief}</span>
      {meta === undefined ? null : (
        <span className="shrink-0 font-mono text-faint tabular-nums">
          {meta}
        </span>
      )}
    </>
  );
  const headClass =
    "flex cursor-pointer items-center gap-2 px-2 py-1 text-[10px] list-none outline-none hover:bg-overlay-hover focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-details-marker]:hidden";
  return (
    <li className="border border-border">
      {hasBody ? (
        // The group is the `details`, not the row: `open:` alone would look for `[open]` on the
        // marker itself, which never carries it, and the arrow would sit there pointing right
        // after the reader clicked it open.
        <details className="group/fold">
          <summary className={headClass}>{head}</summary>
          <div className="group/copy relative border-t border-border">
            <pre className="max-h-56 min-w-0 overflow-y-auto p-2 font-mono text-[11px] whitespace-pre-wrap break-anywhere">
              {body}
            </pre>
            <button
              type="button"
              aria-label={copyLabel}
              title={copyLabel}
              className="absolute top-1 right-1 inline-flex size-6 items-center justify-center bg-muted text-muted-foreground opacity-0 outline-none group-hover/copy:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring pointer-coarse:opacity-100"
              onClick={async () => {
                // No clipboard at all outside a secure context.
                try {
                  await navigator.clipboard.writeText(body ?? "");
                  setCopied(true);
                } catch {
                  toast.error(translateText("common:errors.clipboardBlocked"));
                }
              }}
            >
              {copied ? (
                <CheckIcon
                  aria-hidden="true"
                  className="animate-copied-check"
                />
              ) : (
                <CopyIcon aria-hidden="true" />
              )}
            </button>
          </div>
        </details>
      ) : (
        <div className={headClass}>{head}</div>
      )}
    </li>
  );
}
