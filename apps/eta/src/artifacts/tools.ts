import type { TaskActor } from "@eta/client-contracts";
import type { KernelTool } from "@eta/core";
/**
 * Publishing from a session: the `publish_artifact` tool.
 *
 * The directory is read from this machine's disk, relative to the session's working directory. What
 * is packed is judged by the service (`kinds/site.ts`) and stored as a new version. A version published
 * for a task goes on the task's timeline and into its cards.
 */
import type { SessionHooks } from "../session-hooks";
import type { TaskBoard } from "../tasks/board";
import type { SiteLimits } from "./files";
import type { ArtifactService } from "./service";
import { defineTool, text, toKernelTool, toolError } from "@eta/harness";
import { Type } from "typebox";
import { ArtifactError, collectSite } from "./files";

/** The tool needs nothing from the run: where it reads is the session's own directory. */
type Context = Record<string, never>;

const contextOf = (): Context => ({});

const parameters = () =>
  Type.Object({
    path: Type.String({
      description:
        "The directory to publish, relative to the working directory. Its root must have index.html.",
    }),
    title: Type.String({ description: "What this site is called" }),
    spa: Type.Optional(
      Type.Boolean({
        description:
          "This is a single-page app with path routes: a navigation to an address with no file gets index.html (a missing .js, .css or image is still a 404). Off by default",
      }),
    ),
    artifactId: Type.Optional(
      Type.String({
        description:
          "The id of an artifact you published, to add a version to it",
      }),
    ),
    taskId: Type.Optional(
      Type.String({
        description:
          "The task this is for, by number (12 or #12) or id: it goes on the task's timeline and into its card",
      }),
    ),
  });

export function artifactSessionTools(deps: {
  artifacts: ArtifactService;
  board: TaskBoard;
  limits: SiteLimits;
}): NonNullable<SessionHooks["sessionTools"]> {
  return ({ meta }) => {
    const { agentId, conversationId } = meta;
    if (agentId === undefined || conversationId === undefined) return [];
    const actor: TaskActor = { kind: "agent", agentId };

    const publish = defineTool<Context, ReturnType<typeof parameters>>({
      name: "publish_artifact",
      label: "publish_artifact",
      description:
        "Publish a static site as an artifact the user can preview, share and download: a " +
        "directory with index.html at its root, plus any CSS, scripts and images. Publishing " +
        "again with `artifactId` adds a version to the artifact you published, instead of making " +
        "a second one. Symbolic links are refused; .git and node_modules are left out. The page " +
        "runs in a sandbox: it can use scripts, but it cannot reach the host's API, cookies or " +
        "anything else of the user's. localStorage, cookies, IndexedDB and Service Workers are " +
        "not available, and there is no backend: only GET requests for the published files.\n\n" +
        "Building for it: the site is served under a path of its own, so use relative asset " +
        "paths. For a Vite project set `base: './'`, run `vite build` yourself and publish " +
        "`dist`. Route with the hash, or set `spa: true` for path routes; with `spa` a root path " +
        "such as `/assets/app.js` in index.html is refused, and the router needs " +
        '`basename={new URL(".", document.baseURI).pathname}`.',
      parameters: parameters(),
      async execute(args, run) {
        try {
          const task =
            args.taskId === undefined
              ? undefined
              : deps.board.find(args.taskId);
          if (args.taskId !== undefined && task === undefined)
            throw new ArtifactError(`no such task: ${args.taskId}`);
          const files = await collectSite(
            meta.cwd,
            args.path,
            deps.limits,
            run.call.signal,
          );
          const { artifact, version } = await deps.artifacts.publish({
            title: args.title,
            files,
            options: args.spa === true ? { fallback: "index.html" } : {},
            artifactId: args.artifactId,
            taskId: task?.id,
            conversationId,
            publisherAgentId: agentId,
          });
          if (artifact.taskId !== null) {
            deps.board.artifactPublished(
              artifact.taskId,
              {
                artifactId: artifact.id,
                title: artifact.title,
                version: version.number,
              },
              actor,
            );
          }
          return text(
            `Published "${artifact.title}" version ${version.number} (${version.files} files). ` +
              "The user can preview, share and download it.",
            {
              artifactId: artifact.id,
              title: artifact.title,
              version: version.number,
              files: version.files,
            },
          );
        } catch (error) {
          if (error instanceof ArtifactError) return toolError(error.message);
          throw error;
        }
      },
    });

    return [toKernelTool(publish, contextOf)] as KernelTool[];
  };
}
