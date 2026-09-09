/** update_state / check_state / list_state: the model's KV surface (C6). */

import { Type } from "typebox";
import type { Context } from "../context.ts";
import type { AgentHarnessTool } from "../types.ts";
import type { EtaEmit } from "../events.ts";
import { withId } from "./shared.ts";

export interface StateKV {
	get(key: string): Promise<string | undefined>;
	/** null deletes the key. */
	set(key: string, value: string | null): Promise<void>;
	keys(): Promise<string[]>;
}

export function createStateTools(kv: StateKV, observe?: EtaEmit): AgentHarnessTool<object | undefined, any, any>[] {
	return [
		{
			name: "update_state",
			label: "update_state",
			description: "Store a string under a session KV key. Pass value null to delete it.",
			parameters: Type.Object({ key: Type.String(), value: Type.Union([Type.String(), Type.Null()]) }),
			async execute(_id, { key, value }) {
				await kv.set(key, value);
				observe?.("state", value === null ? "delete" : "set", { key });
				return withId(value === null ? `Deleted ${key}.` : `Stored ${key}.`, { key });
			},
		},
		{
			name: "check_state",
			label: "check_state",
			description: "Read one session KV key.",
			parameters: Type.Object({ key: Type.String() }),
			async execute(_id, { key }) {
				const value = await kv.get(key);
				return withId(value === undefined ? `${key} is not set.` : value, { key, value });
			},
		},
		{
			name: "list_state",
			label: "list_state",
			description: "List session KV keys.",
			parameters: Type.Object({}),
			async execute() {
				const keys = await kv.keys();
				return withId(keys.length === 0 ? "No state keys." : keys.join("\n"), { keys });
			},
		},
	];
}
