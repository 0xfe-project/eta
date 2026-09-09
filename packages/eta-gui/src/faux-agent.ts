/**
 * Demo agent for the window smoke run: an EtaAgent on a faux model so the GUI
 * can be exercised end to end without API keys. Real model wiring is a caller
 * concern of `Host.open`.
 */

import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT, EtaAgent, MemoryStorage, StorageBackedSession } from "@eta/core";

export async function makeFauxAgent(id: string): Promise<EtaAgent> {
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("first frame, fed by the real core")]);
	const models = createModels();
	models.setProvider(faux.provider);
	const storage = new MemoryStorage();
	const session = new StorageBackedSession({ id, createdAt: Date.now(), storageVersion: 1 }, storage);
	return EtaAgent.create({ session, models, model: faux.getModel(), heartbeatMs: 0 }, BACKGROUND_CONTEXT);
}
