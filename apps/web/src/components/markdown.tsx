import type { Options } from "react-markdown";
import type { RehypeRewriteOptions } from "rehype-rewrite";
import { cjk } from "@streamdown/cjk";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeRewrite from "rehype-rewrite";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

// CJK plugins wrap remark-gfm: bare URLs stop at full-width punctuation, and
// emphasis/strikethrough work next to Chinese text.
const remarkPlugins = [
  ...cjk.remarkPluginsBefore,
  remarkGfm,
  ...cjk.remarkPluginsAfter,
];

const linkOptions: RehypeRewriteOptions = {
  selector: "a",
  rewrite(node) {
    if (node.type !== "element") return;
    const href = node.properties.href;
    // Keep document anchors (including footnotes) and mail/phone handlers local.
    if (
      typeof href !== "string" ||
      !defaultUrlTransform(href) ||
      /^(?:#|mailto:|tel:)/i.test(href)
    )
      return;
    node.properties.target = "_blank";
    node.properties.rel = ["noopener", "noreferrer"];
  },
};
const rehypePlugins: Options["rehypePlugins"] = [[rehypeRewrite, linkOptions]];

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
