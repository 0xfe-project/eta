/**
 * btw — a side request next to the run (port of eta-agent's `harness/btw.ts`,
 * the side-request half).
 *
 * Someone asks the agent something while it is working. The honest answer is a
 * *request*, not a second session: it inherits what the run is, and it does not
 * disturb it.
 *
 * What it inherits, read fresh on every ask and never cached (a model or toolset
 * switch applies to the very next question):
 * - the main run's request state — model, thinking level, tool declarations,
 *   system prompt, tool context, retry policy — through `requestState()`, so
 *   there is no second set of selectors to keep in sync and no override state
 *   that can drift from the run it is meant to match;
 * - the tools, minus `ask_user`. That tool waits for a human, and the UI has one
 *   question slot that the main run owns: a side request that asked would either
 *   steal it or hang until timeout, which is the opposite of a channel that
 *   answers in seconds. So the tool is subtracted from the declarations, and a
 *   model that calls it anyway gets an unknown-tool result rather than a wait.
 *
 * What it does not do: block the run (it is a plain promise the caller may await
 * or not), or run forever. A per-request cap and a shared budget across the
 * question bound it, the loop stops after a few tool turns, and running out
 * mid-way still answers with what it knows — a stopped answer is still the
 * truth, and a thread that refuses to answer over its own bookkeeping is worse
 * than one that says less.
 */

import type { Api, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
	type AgentMessage,
	type AssistantMessage,
	addUsage,
	emptyUsage,
	type KernelModels,
	type Message,
	type Model,
	type RequestState,
	type ToolCall,
	type Usage,
} from "@eta/core";

/** Output cap per request and across one question: turns add up, so the budget is shared. */
export const SIDE_MAX_TOKENS = 1024;
export const SIDE_TOKEN_BUDGET = 4096;
/** Turns one question may spend on tools before the answer is demanded. */
export const SIDE_MAX_TOOL_TURNS = 4;

/** The tool a side request never inherits. */
export const SIDE_EXCLUDED_TOOLS: ReadonlySet<string> = new Set(["ask_user"]);

export interface BtwSideRequest {
	threadId: string;
	question: string;
	/** Everything the thread already knows, oldest first. */
	messages: AgentMessage[];
}

export interface BtwToolStep {
	tool: string;
	ok: boolean;
	at: number;
}

/** What a side request gives back: the answer, what it cost, and what it ran. */
export interface BtwSideAnswer {
	text: string;
	usage: Usage;
	steps: BtwToolStep[];
}

export type BtwSideAsk = (request: BtwSideRequest) => Promise<BtwSideAnswer>;

export interface BtwSideAskDeps {
	models: KernelModels;
	/**
	 * The main run's request state as of now. Read per request, never cached, so a
	 * side request inherits a model or toolset switch the moment it happens.
	 */
	requestState: () => Promise<RequestState | undefined>;
	/**
	 * Run one tool call through the kernel's own chain (middleware, gates, the tool
	 * context the prompt was built with). A tool failure arrives as an error result,
	 * so the side model sees a failed tool rather than a crashed request.
	 */
	executeTool: (
		call: ToolCall,
		info: { threadId: string; toolContext: unknown; turn: number },
	) => Promise<AgentMessage>;
	/** Project the thread into provider messages, as a run does for its transcript. */
	toProviderMessages?: ((messages: readonly AgentMessage[]) => Message[]) | undefined;
	/** A side answer is real spend; the host records it against the session. */
	onUsage?: ((usage: Usage, threadId: string) => void) | undefined;
}

/** What a run answers when a tool it does not have is called. */
function unknownToolResult(call: ToolCall): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text: `unknown tool: ${call.name}` }],
		isError: true,
		timestamp: Date.now(),
	} as AgentMessage;
}

/** The text an assistant message said, without its thinking or tool calls. */
function textOf(message: AssistantMessage): string {
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function sideUser(text: string, at: number): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: at } as AgentMessage;
}

/** The stock side ask: a bounded request-and-tools round on the run's own model, prompt and tools. */
export function btwSideAsk(deps: BtwSideAskDeps): BtwSideAsk {
	const project = deps.toProviderMessages ?? ((messages: readonly AgentMessage[]): Message[] => messages as Message[]);
	return async (request: BtwSideRequest): Promise<BtwSideAnswer> => {
		const state = await deps.requestState();
		if (state === undefined) throw new Error("no session to inherit the side request from");
		const model = state.model;
		if (model === undefined) throw new Error("no model configured for this session");

		const tools = state.tools.filter((tool) => !SIDE_EXCLUDED_TOOLS.has(tool.name));
		const skipped = state.missingToolNames.filter((name) => !SIDE_EXCLUDED_TOOLS.has(name));
		const messages: AgentMessage[] = [...request.messages, sideUser(request.question, Date.now())];
		const steps: BtwToolStep[] = [];
		let usage = emptyUsage();
		let budget = SIDE_TOKEN_BUDGET;
		let text = "";

		for (let turn = 0; ; turn += 1) {
			const response = await complete(
				deps.models,
				model,
				state,
				messages,
				project,
				tools,
				Math.min(SIDE_MAX_TOKENS, budget),
			);
			usage = addUsage(usage, response.usage);
			// The budget is what the whole question cost, not what its last turn cost.
			budget -= response.usage?.totalTokens ?? 0;
			text = textOf(response);
			const calls = response.content.filter((part): part is ToolCall => part.type === "toolCall");
			if (response.stopReason === "error") {
				throw new Error(response.errorMessage ?? "the side request failed");
			}
			if (calls.length === 0 || turn >= SIDE_MAX_TOOL_TURNS || budget <= 0) {
				if (calls.length > 0) {
					text = [
						text,
						`(the side request stopped at ${calls.length} pending tool calls: its turn or token budget ran out)`,
					]
						.filter((part) => part.length > 0)
						.join("\n");
				}
				break;
			}
			messages.push(response);
			for (const call of calls) {
				// A model can call a tool that was never declared. For the excluded
				// tools that must not become a wait: the answer is "unknown tool",
				// the same thing a run says for a tool it does not have.
				const result = SIDE_EXCLUDED_TOOLS.has(call.name)
					? (unknownToolResult(call) as AgentMessage)
					: await deps.executeTool(call, {
							threadId: request.threadId,
							toolContext: state.toolContext,
							turn,
						});
				steps.push({ tool: call.name, ok: !(result as { isError?: boolean }).isError, at: Date.now() });
				messages.push(result);
			}
		}

		// An active tool the session never defined would have made a run fail. Here the
		// request still answers, with the gap admitted.
		const note = skipped.length === 0 ? "" : `\n(unavailable this time: ${skipped.join(", ")})`;
		const answer = text.length === 0 ? "(the side request returned no text)" : text + note;
		deps.onUsage?.(usage, request.threadId);
		return { text: answer, usage, steps };
	};
}

/** One side turn: the run's own prompt/model/thinking, this turn's cap, and no reasoning override. */
async function complete(
	models: KernelModels,
	model: Model<Api>,
	state: RequestState,
	messages: AgentMessage[],
	project: (messages: readonly AgentMessage[]) => Message[],
	tools: RequestState["tools"],
	maxTokens: number,
): Promise<AssistantMessage> {
	const streamOptions: SimpleStreamOptions = {
		...(state.streamOptions ?? {}),
		maxTokens,
		// "off" is the kernel's spelling for "no reasoning field at all".
		...(state.thinkingLevel === "off" ? {} : { reasoning: state.thinkingLevel }),
	};
	return await models.completeSimple(
		model,
		{
			systemPrompt: state.systemPrompt,
			messages: project(messages),
			...(tools.length === 0 ? {} : { tools }),
		},
		streamOptions,
	);
}
