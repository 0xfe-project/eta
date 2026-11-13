import type { ComponentProps } from "react";
import type { Components, ExtraProps, PluginConfig } from "streamdown";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { cjk } from "@streamdown/cjk";
import { math } from "@streamdown/math";
import { createElement, memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { defaultRehypePlugins, Streamdown } from "streamdown";
import { cn } from "@/lib/utils";
import "katex/dist/katex.min.css";

// The CJK plugin wraps remark-gfm: bare URLs stop at full-width punctuation,
// and emphasis/strikethrough work next to Chinese text. The math plugin adds
// remark-math + rehype-katex: $$…$$ renders as KaTeX, inline or block.
const plugins: PluginConfig = { cjk, math };

// remark-math knows only $$; people and agents also write LaTeX's \[ … \] and
// \( … \). Rewrite those outside code, and only when the body looks like math:
// an escaped bracket pair such as \[1,2\] is a literal, not a formula.
const mathy = /\\[a-z]{2,}|[_^=]/i;
const fenced = /(```[\s\S]*?```|`[^`\n]*`)/g;
function bracketMath(text: string) {
  const rewrite = (piece: string) =>
    piece
      .replace(/\\\[([\s\S]+?)\\\]/g, (match, body: string) =>
        mathy.test(body) ? `\n$$\n${body.trim()}\n$$\n` : match,
      )
      .replace(/\\\(([\s\S]+?)\\\)/g, (match, body: string) =>
        mathy.test(body) ? `$${body.trim()}$$` : match,
      );
  // Odd indexes are the code the split captured: left exactly as written.
  return text
    .split(fenced)
    .map((piece, i) => (i % 2 === 1 ? piece : rewrite(piece)))
    .join("");
}

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
        {bracketMath(children)}
      </Streamdown>
    );
  },
);
