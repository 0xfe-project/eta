import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { osHomeDir } from "node:os";
import { BACKGROUND_CONTEXT, SessionViewProjector } from "@eta/core";
import { createSessionAgent } from "./src/agent.ts";

const dir = process.argv[2];
const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"));
const made = await createSessionAgent({
	name: "probe",
	personaId: meta.personaId,
	cwd: meta.cwd,
	...(meta.modelId ? { modelId: meta.modelId } : {}),
	persistDir: dir,
});
await made.agent.restore(BACKGROUND_CONTEXT);
const view = await new SessionViewProjector(made.agent).snapshot(BACKGROUND_CONTEXT);
console.log("agentTools:", made.agent.agentTools.length);
console.log("view.tools:", view.tools.length, view.tools.slice(0, 8).map((t) => t.name).join(","));
void osHomeDir;
