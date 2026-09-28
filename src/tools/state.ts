/**
 * The state tools (port of eta-agent's `tools/state.ts`).
 *
 * Three verbs over the session's own KV: store a string under a key, read one
 * back, list the keys. `null` deletes. The store lives in the journal, so what a
 * model writes down here is there after a restart.
 */
import { type TSchema, Type } from "typebox";
import type { StateKV } from "../state";
import type { HarnessTool, ToolResult } from "./tool";

export const stateToolSchemas = {
	update: Type.Object({ key: Type.String(), value: Type.Union([Type.String(), Type.Null()]) }),
	check: Type.Object({ key: Type.String() }),
	list: Type.Object({}),
};

/** The three state tools over a session KV. */
export function createStateTools(kv: StateKV): HarnessTool<object | undefined, TSchema, unknown>[] {
	return [
		{
			name: "update_state",
			label: "update_state",
			description: "Store a string under a session KV key. Pass value null to delete it.",
			parameters: stateToolSchemas.update,
			async execute(args: { key: string; value: string | null }): Promise<ToolResult<unknown>> {
				await kv.set(args.key, args.value);
				return {
					content: [{ type: "text", text: args.value === null ? `Deleted ${args.key}.` : `Stored ${args.key}.` }],
					details: { key: args.key },
				};
			},
		},
		{
			name: "check_state",
			label: "check_state",
			description: "Read one session KV key.",
			parameters: stateToolSchemas.check,
			async execute(args: { key: string }): Promise<ToolResult<unknown>> {
				const stored = await kv.get(args.key);
				return {
					content: [{ type: "text", text: stored === undefined ? `${args.key} is not set.` : stored }],
					details: { key: args.key, value: stored },
				};
			},
		},
		{
			name: "list_state",
			label: "list_state",
			description: "List session KV keys.",
			parameters: stateToolSchemas.list,
			async execute(): Promise<ToolResult<unknown>> {
				const keys = await kv.keys();
				return {
					content: [{ type: "text", text: keys.length === 0 ? "No state keys." : keys.join("\n") }],
					details: { keys },
				};
			},
		},
	];
}
