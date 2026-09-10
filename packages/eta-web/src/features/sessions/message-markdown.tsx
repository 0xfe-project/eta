import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import "katex/dist/katex.min.css";

const plugins = { code, math };

export function MarkdownMessage({ content }: { content: string }) {
	return (
		<Streamdown mode="streaming" plugins={plugins} className="message-content markdown" data-testid="message-markdown">
			{content}
		</Streamdown>
	);
}

export function MessageMarkdown({ content, streaming }: { content: string; streaming: boolean }) {
	return (
		<Streamdown
			mode="streaming"
			isAnimating={streaming}
			plugins={plugins}
			className={"message-content markdown" + (streaming ? " streaming" : "")}
			data-testid="message-markdown"
		>
			{content}
		</Streamdown>
	);
}
