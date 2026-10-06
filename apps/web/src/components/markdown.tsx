import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

const remarkPlugins = [remarkGfm];

export function Markdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={cn("markdown", className)}>
      <ReactMarkdown remarkPlugins={remarkPlugins} skipHtml>
        {children}
      </ReactMarkdown>
    </div>
  );
}
