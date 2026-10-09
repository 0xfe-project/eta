import type { Options } from "react-markdown";
import { cjk } from "@streamdown/cjk";
import ReactMarkdown from "react-markdown";
import rehypeExternalLinks from "rehype-external-links";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

// CJK plugins wrap remark-gfm: bare URLs stop at full-width punctuation, and
// emphasis/strikethrough work next to Chinese text.
const remarkPlugins = [
  ...cjk.remarkPluginsBefore,
  remarkGfm,
  ...cjk.remarkPluginsAfter,
];

const rehypePlugins: Options["rehypePlugins"] = [
  [rehypeExternalLinks, { target: "_blank", rel: ["noopener", "noreferrer"] }],
];

export function Markdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={cn("markdown", className)}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        skipHtml
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
