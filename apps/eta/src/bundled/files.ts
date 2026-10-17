import type { Context } from "cordis";
import type { GroupStore } from "../groups/store";
import type { PluginContext } from "../plugin-api";
import { errorResponse } from "../routes";

/**
 * The project's files, for the composer's `@` completion.
 *
 * Two decisions worth writing down:
 *
 * Paths are **relative to the group's folder**, because that is what a mention means: the agent
 * runs in that folder, so `@src/app.ts` is a path it can open. Absolute paths would be longer,
 * leak where the project lives, and break the moment the group is moved.
 *
 * Directories that never hold a file a person means are skipped rather than filtered later:
 * `node_modules`, `.git`, `dist`, and the data directory. The list is capped so a big repository
 * cannot turn a menu into a hang — the composer filters what it gets, and `q` narrows it on the
 * server when the caller already knows what it is looking for.
 */
export interface FilesPluginConfig {
  groups: GroupStore;
}

/** Directories whose contents are never what a person is pointing at. */
const SKIP = new Set([
  "node_modules",
  ".git",
  ".eta",
  "dist",
  "out",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "target",
  "vendor",
]);

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;
/** Deeper than this is not a project layout, it is a filesystem. */
const MAX_DEPTH = 8;

async function walk(
  root: string,
  limit: number,
  needle: string,
): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const found: string[] = [];
  const queue: { dir: string; prefix: string; depth: number }[] = [
    { dir: root, prefix: "", depth: 0 },
  ];
  while (queue.length > 0 && found.length < limit) {
    const next = queue.shift()!;
    let entries;
    try {
      entries = await readdir(next.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (found.length >= limit) break;
      if (entry.name.startsWith(".") && entry.name !== ".env") {
        // Dotfiles are noise in a completion list; `.env` is the one people mention.
        if (!entry.isFile()) continue;
      }
      const relative =
        next.prefix.length === 0 ? entry.name : `${next.prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP.has(entry.name) || next.depth + 1 > MAX_DEPTH) continue;
        queue.push({
          dir: join(next.dir, entry.name),
          prefix: relative,
          depth: next.depth + 1,
        });
        continue;
      }
      if (!entry.isFile()) continue;
      if (needle.length > 0 && !relative.toLowerCase().includes(needle))
        continue;
      found.push(relative);
    }
  }
  return found.sort();
}

export const filesPlugin = {
  name: "files",
  inject: ["routes"],
  apply(ctx: Context, config: FilesPluginConfig): void {
    const plugin = ctx as unknown as PluginContext;
    const { groups } = config;

    plugin.effect(() =>
      plugin.routes.register("GET", "/api/v1/files", async (request) => {
        const url = new URL(request.url);
        const groupId = url.searchParams.get("group_id") ?? "";
        const group = groups.get(groupId);
        if (group === undefined) {
          return errorResponse(
            404,
            "NO_SUCH_GROUP",
            `no group ${groupId}`,
            crypto.randomUUID(),
          );
        }
        if (group.group.cwd.length === 0) {
          // Not an error: a group with no folder has no project, so there is nothing to complete.
          // Saying so is better than walking the host's own directory and offering its files.
          return Response.json({ files: [], cwd: null });
        }
        const rawLimit = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
        const limit = Number.isFinite(rawLimit)
          ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(rawLimit)))
          : DEFAULT_LIMIT;
        const needle = (url.searchParams.get("q") ?? "").toLowerCase();
        const files = await walk(group.group.cwd, limit, needle);
        return Response.json({ files, cwd: group.group.cwd });
      }),
    );
  },
};
