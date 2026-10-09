import type { Components, ExtraProps, PluginConfig } from "streamdown";
import { cjk } from "@streamdown/cjk";
import { createElement, memo } from "react";
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
      "pre",
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
