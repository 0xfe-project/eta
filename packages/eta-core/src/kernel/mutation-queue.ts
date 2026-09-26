/**
 * Keyed mutation queue — serialize work that touches the same resource
 * (port of eta-agent's tools/file-mutation-queue.ts, with the filesystem
 * lifted out).
 *
 * The kernel does not know what a path is; it knows that two mutations of the
 * same key must not interleave. A tools plugin keys on the canonical path, so
 * two edits of one file in the same parallel batch land in order instead of
 * clobbering each other, while edits of different files still run together.
 *
 * Key resolution is itself async and is ordered: registrations are chained, so
 * two callers that resolve to the same key always queue in call order.
 */
export class MutationQueue {
	private readonly queues = new Map<string, Promise<void>>();
	/** Chains key resolution, so the queue order is the call order. */
	private registration: Promise<void> = Promise.resolve();

	async run<T>(key: string | Promise<string>, fn: () => Promise<T>): Promise<T> {
		const registration = this.registration.then(async () => {
			const resolved = await key;
			const current = this.queues.get(resolved) ?? Promise.resolve();
			let releaseNext = (): void => {};
			const next = new Promise<void>((resolve) => {
				releaseNext = resolve;
			});
			const chained = current.then(() => next);
			this.queues.set(resolved, chained);
			return { resolved, current, chained, releaseNext };
		});
		this.registration = registration.then(
			() => undefined,
			() => undefined,
		);

		const { resolved, current, chained, releaseNext } = await registration;
		await current;
		try {
			return await fn();
		} finally {
			releaseNext();
			// Last one out drops the key, so a long session does not accumulate one
			// promise per file it ever touched.
			if (this.queues.get(resolved) === chained) this.queues.delete(resolved);
		}
	}

	/** Keys with work still queued. */
	get depth(): number {
		return this.queues.size;
	}
}
