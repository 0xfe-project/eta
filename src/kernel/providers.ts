/**
 * Providers — the model seam (REFACTOR.md §2.2).
 *
 * No new interface is invented around provider internals: the vocabulary IS
 * pi-ai's (Model, Context, SimpleStreamOptions, AssistantMessage). A seam
 * implementation is just "produce a settled AssistantMessage for this
 * model+context"; the built-in adapter delegates to pi-ai's completeSimple,
 * and tests inject a scripted fake. The kernel never sees networks or SDKs.
 */
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

export interface ProviderSeam {
	complete(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage>;
}

/**
 * The production seam: delegates to pi-ai. Never throws for request/model/
 * runtime failures — pi-ai encodes those as an AssistantMessage with
 * stopReason "error" and errorMessage, and so must any other implementation.
 */
export function piAiProviders(adapter: {
	completeSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage>;
}): ProviderSeam {
	return {
		complete: (model, context, options) => adapter.completeSimple(model, context, options),
	};
}
