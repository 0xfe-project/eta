/**
 * The model seam (REFACTOR.md §2.2).
 *
 * No new interface is invented around provider internals: the kernel needs
 * three methods off pi-ai's `Models`, and that is what it declares. A real
 * `Models` instance satisfies it as-is; tests pass a scripted fake.
 */
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "../types/messages";

/**
 * What the kernel asks of the model layer: resolve the configured model, then
 * stream (or complete) a request. Auth, retries at the transport level, and
 * provider catalogs stay behind this edge.
 */
export type KernelModels = Pick<Models, "getModel" | "streamSimple" | "completeSimple">;

/**
 * Every thinking level, as a runtime list. The union is compile-time only, and a
 * configuration coming off the wire has to be checked against something.
 */
export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ThinkingLevel[];

/**
 * The levels a model can actually be asked for.
 *
 * A camera model on a non-reasoning provider: `off`. Otherwise the provider's own map
 * decides — a level marked `null` is one the model does not take, and a level the map
 * does not mention is left to the provider's default, which is why an unmentioned level
 * counts as supported rather than as absent.
 */
export function thinkingLevelsFor(model: Model<Api> | undefined): ThinkingLevel[] {
	if (model === undefined) return [...THINKING_LEVELS];
	if (model.reasoning !== true) return ["off"];
	const map = model.thinkingLevelMap ?? {};
	return THINKING_LEVELS.filter((level) => map[level as keyof typeof map] !== null);
}

/**
 * Delegate to a pi-ai `Models` collection. Kept as a function so a host can
 * wrap it (metrics, a recording proxy) without the kernel knowing.
 */
export function piAiModels(models: KernelModels): KernelModels {
	return {
		getModel: (provider, id) => models.getModel(provider, id),
		streamSimple: (model, context, options) => models.streamSimple(model, context, options),
		completeSimple: (model, context, options) => models.completeSimple(model, context, options),
	};
}
