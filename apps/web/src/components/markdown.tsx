import type { ComponentProps } from "react";
import type { Components, ExtraProps, PluginConfig } from "streamdown";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { cjk } from "@streamdown/cjk";
import { createElement, memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { defaultRehypePlugins, Streamdown } from "streamdown";
import { cn } from "@/lib/utils";

// The CJK plugin wraps remark-gfm: bare URLs stop at full-width punctuation,
// and emphasis/strikethrough work next to Chinese text.
const plugins: PluginConfig = { cjk };

// Streamdown's own elements bring their own styles, code/table toolbars and a
// link confirmation; plain elements keep `.markdown`'s look (styles.css).
function plain(tag: string) {
  return ({ node: _, ...props }: Record<string, unknown> & ExtraProps) =>
    createElement(tag, props);
}
/** A code block with a button that copies its text. */
function CodeBlock({ node: _, ...props }: ComponentProps<"pre"> & ExtraProps) {
  const { t: translateText } = useTranslation("common");
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(setCopied, 2500, false);
    return () => clearTimeout(id);
  }, [copied]);
  const label = copied
    ? translateText("feedback.copied")
    : translateText("actions.copy");
  return (
    <div className="group/code relative">
      <pre ref={ref} {...props} />
      <button
        type="button"
        aria-label={label}
        title={label}
        className="absolute top-1 right-1 inline-flex size-6 items-center justify-center bg-muted text-muted-foreground opacity-0 outline-none group-hover/code:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring pointer-coarse:opacity-100"
        onClick={async () => {
          // No clipboard at all outside a secure context.
          try {
            await navigator.clipboard.writeText(ref.current?.textContent ?? "");
            setCopied(true);
          } catch {
            toast.error(translateText("errors.clipboardBlocked"));
          }
        }}
      >
        {copied ? (
          // Holds for a beat, then fades as the copy icon comes back.
          <CheckIcon aria-hidden="true" className="animate-copied-check" />
        ) : (
          <CopyIcon aria-hidden="true" />
        )}
      </button>
    </div>
  );
}

const components: Components = {
  ...Object.fromEntries(
    [
      "blockquote",
      "code",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "hr",
      "img",
      "li",
      "ol",
      "p",
      "section",
      "strong",
      "sub",
      "sup",
      "table",
      "tbody",
      "td",
      "th",
      "thead",
      "tr",
      "ul",
    ].map((tag) => [tag, plain(tag)]),
  ),
  pre: CodeBlock,
  // Links leave the app: a new tab, and no opener or referrer.
  // A link still being written has no destination yet.
  a: ({ node: _, href, ...props }) => (
    <a
      {...props}
      href={href === "streamdown:incomplete-link" ? undefined : href}
      target="_blank"
      rel="noopener noreferrer"
    />
  ),
};
const linkSafety = { enabled: false };
// Without rehype-raw, raw HTML shows as text instead of elements; sanitize
// still drops unsafe URLs.
const rehypePlugins = [defaultRehypePlugins.sanitize];

/**
 * Markdown from agents and people; raw HTML is not rendered. `streaming` is for
 * text still being written: it closes unfinished syntax at the end and only
 * reparses the last block as it grows.
 */
export const Markdown = memo(
  ({
    children,
    className,
    streaming = false,
  }: {
    children: string;
    className?: string;
    streaming?: boolean;
  }) => {
    return (
      <Streamdown
        // space-y-3 replaces Streamdown's space-y-4, to match `.markdown`.
        className={cn("markdown space-y-3", className)}
        mode={streaming ? "streaming" : "static"}
        isAnimating={streaming}
        plugins={plugins}
        components={components}
        controls={false}
        linkSafety={linkSafety}
        rehypePlugins={rehypePlugins}
        skipHtml
      >
        {children}
      </Streamdown>
    );
  },
);
