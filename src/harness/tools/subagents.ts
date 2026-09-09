/** Agent / get_subagent_result / steer_subagent over the subagent manager (C7). */

import { Type } from "typebox";
import type { Context } from "../context.ts";
import type { AgentHarnessTool } from "../types.ts";
import type { SubagentManager } from "../subagent.ts";
import { withId } from "./shared.ts";

export function createSubagentTools(manager: SubagentManager, ownerId?: string): AgentHarnessTool<object | undefined, any, any>[] {
	return [
		{
			name: "Agent",
			label: "Agent",
			description: "Spawn a subagent on a task. background=true returns immediately; otherwise it runs to completion first.",
			parameters: Type.Object({
				task: Type.String(),
				model: Type.Optional(Type.String()),
				background: Type.Optional(Type.Boolean()),
				maxTurns: Type.Optional(Type.Number()),
			}),
			async execute(_id, { task, model, background, maxTurns }) {
				const spec = { prompt: task, ...(model !== undefined ? { model } : {}), ...(maxTurns !== undefined ? { maxTurns } : {}) };
				const record = background === true ? manager.spawn(spec, ownerId) : manager.spawnAndWait(spec, ownerId);
				return withId(`${record.id} ${record.status} (in ${record.totalUsage.input}/out ${record.totalUsage.output})`, { record: { id: record.id, status: record.status } });
			},
		},
		{
			name: "get_subagent_result",
			label: "get_subagent_result",
			description: "Fetch a subagent's status and rolled-up usage.",
			parameters: Type.Object({ id: Type.String() }),
			async execute(_id, { id }) {
				const record = manager.get(id);
				if (record === undefined) return withId(`No agent ${id}.`, { error: true });
				return withId(`${record.id} ${record.status} (in ${record.totalUsage.input}/out ${record.totalUsage.output})`, {
					id: record.id,
					status: record.status,
					usage: record.totalUsage,
				});
			},
		},
		{
			name: "steer_subagent",
			label: "steer_subagent",
			description: "Queue a steering note for a running subagent.",
			parameters: Type.Object({ id: Type.String(), note: Type.String() }),
			async execute(_id, { id, note }) {
				return withId(manager.steer(id, ownerId, note) ? `Steered ${id}.` : `Can't steer ${id} (unknown, done, or not yours).`, { id, note });
			},
		},
	];
}
