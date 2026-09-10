import { StreamMarkdown } from "solid-streamdown";
import "solid-streamdown/styles.css";
import "katex/dist/katex.min.css";

export function MarkdownMessage(props: { content: string }) {
	return (
		<div data-testid="message-markdown">
			<StreamMarkdown content={props.content} showCaret={false} class="message-content markdown" />
		</div>
	);
}

export function MessageMarkdown(props: { content: string; streaming: boolean }) {
	return (
		<div data-testid="message-markdown">
			<StreamMarkdown
				content={props.content}
				showCaret={props.streaming}
				class={"message-content markdown" + (props.streaming ? " streaming" : "")}
			/>
		</div>
	);
}
