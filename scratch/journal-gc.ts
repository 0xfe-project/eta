/**
 * Bring one session's journal back to a size it can be opened at.
 *
 * The journal is loaded, the state it produced is measured, and the file is rebuilt from
 * that state — which is what `FileStorage` now does on its own when a session opens on a
 * journal that has grown far past what it needs. Run by hand for a session too big for the
 * server to have reopened at all.
 */
import { stat } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "../packages/eta-core/src/harness/context.ts";
import { FileStorage } from "../packages/eta-core/src/harness/session/file-storage.ts";
import type { EntryScan } from "../packages/eta-core/src/harness/session/types.ts";

const path = process.argv[2];
if (path === undefined) {
	console.log("usage: bun scratch/journal-gc.ts <path/to/journal.jsonl>");
	process.exit(1);
}

async function measure(storage: FileStorage): Promise<string> {
	const scan: EntryScan = { limit: 100_000 };
	const [stats, entries, usage] = await Promise.all([
		storage.getStats(BACKGROUND_CONTEXT),
		storage.scanEntries(scan, BACKGROUND_CONTEXT),
		storage.scanUsage({ limit: 100_000 }, BACKGROUND_CONTEXT),
	]);
	const bytes = (await stat(path)).size;
	return JSON.stringify({
		fileMB: Math.round(bytes / 1e6),
		messages: stats.messageCount,
		entries: entries.length,
		usageRows: usage.length,
		tokens: stats.usage.totalTokens,
		rssMB: Math.round(process.memoryUsage().rss / 1e6),
	});
}

const openedAt = Date.now();
const storage = await FileStorage.load({ path, compactOnLoad: false }, BACKGROUND_CONTEXT);
console.log("opened in", Date.now() - openedAt, "ms");
console.log("before:", await measure(storage));

const compactedAt = Date.now();
const result = await storage.compact(BACKGROUND_CONTEXT);
console.log(
	"compacted in",
	Date.now() - compactedAt,
	"ms:",
	result.rewritten ? `${result.beforeBytes} → ${result.afterBytes} bytes` : `skipped (${result.reason})`,
);
await storage.close(BACKGROUND_CONTEXT);

const reopenedAt = Date.now();
const reopened = await FileStorage.load({ path, compactOnLoad: false }, BACKGROUND_CONTEXT);
console.log("reopened in", Date.now() - reopenedAt, "ms");
console.log("after: ", await measure(reopened));
await reopened.close(BACKGROUND_CONTEXT);
process.exit(0);
