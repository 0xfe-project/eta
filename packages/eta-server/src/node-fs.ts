/** EtaFs over node:fs — the persona/memory batteries' filesystem port. */

import { mkdir, readdir, readFile, stat, writeFile as fsWrite } from "node:fs/promises";
import { dirname } from "node:path";
import type { EtaFs } from "@eta/core";

export class NodeEtaFs implements EtaFs {
	async readFile(path: string): Promise<string | undefined> {
		try {
			return await readFile(path, "utf8");
		} catch {
			return undefined;
		}
	}

	async mtime(path: string): Promise<number | undefined> {
		try {
			return (await stat(path)).mtimeMs;
		} catch {
			return undefined;
		}
	}

	async writeFile(path: string, content: string): Promise<void> {
		// The memory battery creates its own file, and `.eta/` may not exist yet.
		await mkdir(dirname(path), { recursive: true });
		await fsWrite(path, content, "utf8");
	}

	async listFileNames(dir: string): Promise<string[]> {
		try {
			const entries = await readdir(dir, { withFileTypes: true });
			return entries.filter((e) => e.isFile()).map((e) => `${dir}/${e.name}`);
		} catch {
			return [];
		}
	}
}
