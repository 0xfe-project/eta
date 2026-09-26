/**
 * The model seam (REFACTOR.md §2.2).
 *
 * No new interface is invented around provider internals: the kernel needs
 * three methods off pi-ai's `Models`, and that is what it declares. A real
 * `Models` instance satisfies it as-is; tests pass a scripted fake.
 */
import type { Models } from "@earendil-works/pi-ai";

/**
 * What the kernel asks of the model layer: resolve the configured model, then
 * stream (or complete) a request. Auth, retries at the transport level, and
 * provider catalogs stay behind this edge.
 */
export type KernelModels = Pick<Models, "getModel" | "streamSimple" | "completeSimple">;

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
