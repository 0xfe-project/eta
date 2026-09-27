/**
 * A kernel wired the way a session assembler wires one when it already holds a
 * journal: the journaling service turned on over that log.
 *
 * `openSession` builds the same pair — it adds the goal, the ledger, compaction
 * and the runner on top. Tests that need the journal but not the whole session
 * use this, so they are wired like a real one instead of like a special case.
 */
import { Kernel, type KernelConfig, type SessionLog } from "@eta/core";
import { JournalingService } from "../journaling";

export interface JournaledKernel {
	kernel: Kernel;
	/** The service writing this kernel's messages, usage rows and state down. */
	journaling: JournalingService;
	log: SessionLog;
}

export function journaledKernel(
	log: SessionLog,
	options: { config?: Partial<KernelConfig>; warn?: (message: string) => void } = {},
): JournaledKernel {
	const kernel = Kernel.create({
		...(options.config === undefined ? {} : { config: options.config }),
		...(options.warn === undefined ? {} : { warn: options.warn }),
	});
	const journaling = new JournalingService(kernel.ctx, {
		journal: log,
		config: kernel.config,
		tasks: kernel.tasks,
		...(options.warn === undefined ? {} : { warn: options.warn }),
	});
	return { kernel, journaling, log };
}
