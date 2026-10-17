import type { Context } from "cordis";
import type { GroupStore } from "../groups/store";
import type { PluginContext } from "../plugin-api";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorResponse } from "../routes";

/**
 * Files a person attaches to a message.
 *
 * The decision that makes this simple: an attachment is **a file in the group's project**, and what
 * the agent gets is its path. Not a separate storage system with its own ids, not image content
 * blocks piped into a model — a file on disk, referenced the way any other file is referenced
 * (`@.eta/uploads/…`). That is the same mechanism the composer already uses for `@` mentions and
 * for long pastes, so there is one way for an agent to reach a file rather than three.
 *
 * Where they go: `<group cwd>/.eta/uploads/`. Inside the project because that is what the
 * conversation is about, and under `.eta/` because it is the app's own scratch space rather than
 * something the person is expected to keep. A group with no folder has nowhere honest to put a
 * file, so that case says so instead of inventing a directory.
 *
 * Names are prefixed with a sortable stamp: two files called `screenshot.png` in one afternoon is
 * normal, and a second upload must not overwrite the first.
 */

export interface AttachmentsPluginConfig {
  groups: GroupStore;
}

const MAX_BYTES = 25 * 1024 * 1024;

/** Strip what a path cannot hold, and keep the name recognisable. */
function safeName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "file";
  const cleaned = [...base]
    .map((character) =>
      character.codePointAt(0)! < 0x20 || '<>:"|?*'.includes(character)
        ? "_"
        : character,
    )
    .join("")
    .trim();
  return cleaned.length === 0 ? "file" : cleaned.slice(0, 120);
}

export const attachmentsPlugin = {
  name: "attachments",
  inject: ["routes"],
  apply(ctx: Context, config: AttachmentsPluginConfig): void {
    const plugin = ctx as unknown as PluginContext;
    const { groups } = config;

    plugin.effect(() =>
      plugin.routes.register(
        "POST",
        "/api/v1/groups/:group_id/attachments",
        async (request, params) => {
          const groupId = params.group_id ?? "";
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
            return errorResponse(
              409,
              "NO_FOLDER",
              "这个群还没绑目录，文件没地方放。先给它一个工作目录。",
              crypto.randomUUID(),
            );
          }
          const requested =
            new URL(request.url).searchParams.get("name") ?? "file";
          const name = safeName(requested);
          const bytes = new Uint8Array(await request.arrayBuffer());
          if (bytes.byteLength === 0) {
            return errorResponse(
              400,
              "EMPTY_FILE",
              "文件是空的。",
              crypto.randomUUID(),
            );
          }
          if (bytes.byteLength > MAX_BYTES) {
            return errorResponse(
              413,
              "FILE_TOO_LARGE",
              "文件太大了（上限 25 MB）。",
              crypto.randomUUID(),
            );
          }
          const stamp = new Date()
            .toISOString()
            .replace(/[-:]/g, "")
            .replace(/\..*$/, "");
          const directory = join(group.group.cwd, ".eta", "uploads");
          const stored = `${stamp}-${name}`;
          await mkdir(directory, { recursive: true });
          await writeFile(join(directory, stored), bytes);
          return Response.json(
            {
              id: crypto.randomUUID(),
              name,
              content_type:
                request.headers.get("content-type") ??
                "application/octet-stream",
              size: bytes.byteLength,
              // Relative to the group's folder, which is where the agent runs: this is the string
              // that goes into the message.
              path: `.eta/uploads/${stored}`,
            },
            { status: 201 },
          );
        },
      ),
    );
  },
};
