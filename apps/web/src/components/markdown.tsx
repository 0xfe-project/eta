import type { Components } from "react-markdown";
import { cjk } from "@streamdown/cjk";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

// CJK plugins wrap remark-gfm: bare URLs stop at full-width punctuation, and
// emphasis/strikethrough work next to Chinese text.
const remarkPlugins = [
  ...cjk.remarkPluginsBefore,
  remarkGfm,
  ...cjk.remarkPluginsAfter,
];

const components: Components = {
  a: ({ node: _node, href, ...props }) => {
    // Keep document anchors (including footnotes) and mail/phone handlers local.
    const newTab = !!href && !/^(?:#|mailto:|tel:)/i.test(href);
    return (
      <a
        {...props}
        href={href}
        target={newTab ? "_blank" : undefined}
        rel={newTab ? "noopener noreferrer" : undefined}
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
        components={components}
        skipHtml
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
