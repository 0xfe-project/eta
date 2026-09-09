import { Streamdown } from "streamdown";

export function MessageMarkdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
	return (
		<div className={`message-content${streaming ? " streaming" : ""}`} data-testid="message-markdown">
			<Streamdown mode={streaming ? "streaming" : "static"}>{text}</Streamdown>
		</div>
	);
}
