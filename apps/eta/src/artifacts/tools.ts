import type { ToolResult } from "@eta/harness";
import type { SessionMeta } from "@eta/server";
import type { TaskStore } from "../tasks/store";
import type { ArtifactService } from "./service";
import type { SiteFile } from "./zip";
/**
 * Publishing from a session (REFACTOR.md §9, P3.2).
 *
 * The agent's half of artifacts: `publish_artifact` takes a directory (packed here) or a ZIP, and
 * publishes it as a new artifact — or a new version of one it already published. The tool result
 * carries a reference, which is what makes a card appear in the conversation the work came from.
 *
 * The path is read from this host's filesystem, which is where a session's tools run. A remote
 * environment would hand the same work to its own side (P4), and this is the one place that would
 * change.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { defineTool, text, toKernelTool, toolError } from "@eta/harness";
import { Type } from "typebox";
import { NotPublisher, StorageFailed } from "./service";
import { InvalidArtifact, writeZip } from "./zip";

export interface ArtifactToolsOptions {
  artifacts: ArtifactService;
  tasks: TaskStore;
  meta: SessionMeta;
  /** Called after a publish that belongs to a task, so its card can list the artifact. */
  onPublished?: ((taskId: string) => void) | undefined;
}

/** Directories that are never part of a site: they are somebody's tooling, not the site. */
const SKIPPED = new Set([".git", "node_modules", ".DS_Store"]);

/**
 * Read a directory as a site: its files, with the paths the ZIP will carry.
 *
 * Symlinks are refused rather than followed — a site that includes one is a site whose contents
 * depend on where it was packed, and the check on the way in refuses them anyway.
 */
async function readDirectory(root: string): Promise<SiteFile[]> {
  const files: SiteFile[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIPPED.has(entry.name)) continue;
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new InvalidArtifact(`不能打包符号链接：${relative(root, full)}`);
      }
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) {
        throw new InvalidArtifact(`只能打包普通文件：${relative(root, full)}`);
      }
      files.push({
        name: relative(root, full).split(sep).join("/"),
        bytes: new Uint8Array(await readFile(full)),
      });
    }
  };
  await walk(root);
  return files.sort((left, right) => left.name.localeCompare(right.name));
}

export function artifactTools(
  options: ArtifactToolsOptions,
): ReturnType<typeof toKernelTool>[] {
  const { artifacts, tasks, meta, onPublished } = options;
  const agentId = typeof meta.agentId === "string" ? meta.agentId : undefined;
  const groupId = typeof meta.groupId === "string" ? meta.groupId : undefined;
  const cwd = meta.cwd;

  const publish = defineTool({
    name: "publish_artifact",
    label: "publish_artifact",
    description:
      "Publish a static site as an artifact the user can preview, share and download: a directory whose root has index.html, or a ZIP of one. Publishing the same title again with `artifact` adds a version instead of a second artifact. The user sees a card; the site cannot read AXP's API, cookies or anything else of the host.",
    parameters: Type.Object({
      title: Type.String({ description: "What this site is called" }),
      path: Type.String({
        description:
          "The directory to pack (its root must have index.html), or a ZIP of one; relative to the session's working directory",
      }),
      artifact: Type.Optional(
        Type.String({
          description:
            "An artifact id to add a version to, when this is a new version",
        }),
      ),
      task: Type.Optional(
        Type.String({
          description: "The task this belongs to, by id or number",
        }),
      ),
    }),
    execute: async (args): Promise<ToolResult> => {
      const target = resolve(cwd, args.path);
      let archive: Uint8Array;
      try {
        const info = await stat(target);
        if (info.isDirectory()) {
          archive = writeZip(await readDirectory(target));
        } else if (info.isFile()) {
          archive = new Uint8Array(await readFile(target));
        } else {
          return toolError(`不是文件也不是目录：${args.path}`);
        }
      } catch (error) {
        return toolError(
          error instanceof Error
            ? `读不到 ${args.path}：${error.message}`
            : String(error),
        );
      }

      const task =
        args.task === undefined
          ? undefined
          : (() => {
              const found = tasks.find(args.task);
              return found === undefined ? "missing" : found.id;
            })();
      if (task === "missing") return toolError(`没有这个任务：${args.task}`);

      try {
        const published = await artifacts.publish({
          title: args.title,
          archive,
          ...(args.artifact === undefined ? {} : { artifactId: args.artifact }),
          ...(task === undefined ? {} : { taskId: task }),
          ...(groupId === undefined ? {} : { groupId }),
          ...(agentId === undefined ? {} : { publisherAgent: agentId }),
        });
        // The task's story gets a line, and its card learns the artifact.
        if (published.artifact.taskId !== undefined) {
          tasks.record({
            taskId: published.artifact.taskId,
            kind: "artifact",
            actor: agentId === undefined ? "user" : "agent",
            ...(agentId === undefined ? {} : { actorAgent: agentId }),
            data: {
              artifact_id: published.artifact.id,
              title: published.artifact.title,
              version: published.version.number,
            },
          });
          onPublished?.(published.artifact.taskId);
        }
        return text(
          `已发布《${published.artifact.title}》第 ${published.version.number} 版（${published.version.files} 个文件）。用户可以在聊天里预览、分享和下载。`,
          {
            artifact_id: published.artifact.id,
            title: published.artifact.title,
            version: published.version.number,
          },
        );
      } catch (error) {
        if (error instanceof InvalidArtifact) return toolError(error.message);
        if (error instanceof NotPublisher) return toolError(error.message);
        if (error instanceof StorageFailed) {
          return toolError(`存储失败：${error.message}`);
        }
        throw error;
      }
    },
  });

  return [toKernelTool(publish as never, () => undefined)];
}
