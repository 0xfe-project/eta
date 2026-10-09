import type { Components, Options } from "react-markdown";
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

const components: Components = {
  a: ({ node: _node, href, ...props }) => {
    // The plugin handles absolute URLs; include relative pages, but keep
    // document anchors and native protocol handlers in their current context.
    const relativePage =
      !!href &&
      !href.startsWith("#") &&
      !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href);
    return (
      <a
        {...props}
        href={href}
        target={relativePage ? "_blank" : props.target}
        rel={relativePage ? "noopener noreferrer" : props.rel}
      />
    );
  },
};

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
        components={components}
        skipHtml
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
