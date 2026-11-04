import type { TaskActor } from "@eta/client-contracts";
import type { KernelTool } from "@eta/core";
import type { ExecutionEnv } from "@eta/harness";
/**
 * Publishing from a session: the `publish_artifact` tool.
 *
 * The directory is read through the session's own execution environment, so a session that runs on
 * another machine publishes what is on that machine and the tool needs no idea where that is. What
 * is packed is judged by the service (`site.ts`) and stored as a new version. A version published
 * for a task goes on the task's timeline and into its cards.
 */
import type { SessionHooks } from "../session-hooks";
import type { TaskBoard } from "../tasks/board";
import type { ArtifactService } from "./service";
import type { SiteLimits } from "./site";
import { defineTool, text, toKernelTool, toolError } from "@eta/harness";
import { Type } from "typebox";
import { ArtifactError, collectSite } from "./site";

/** What the session's run hands its tools: an environment, when this runtime could make one. */
interface Context {
  env: ExecutionEnv | undefined;
}

const contextOf = (toolContext: unknown): Context => ({
  env: (toolContext as { env?: ExecutionEnv } | undefined)?.env,
});

const parameters = () =>
  Type.Object({
    path: Type.String({
      description:
        "The directory to publish, relative to the working directory. Its root must have index.html.",
    }),
    title: Type.String({ description: "What this site is called" }),
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
        "anything else of the user's.",
      parameters: parameters(),
      async execute(args, run) {
        if (run.context.env === undefined) {
          // The files are read on eta's side, through the environment the host gave this
          // session, not through whatever the agent itself can reach.
          return toolError(
            "eta has no execution environment for this session to read the directory from, so it cannot publish it",
          );
        }
        try {
          const task =
            args.taskId === undefined
              ? undefined
              : deps.board.find(args.taskId);
          if (args.taskId !== undefined && task === undefined)
            throw new ArtifactError(`no such task: ${args.taskId}`);
          const files = await collectSite(
            run.context.env,
            args.path,
            deps.limits,
            run.call.signal,
          );
          const { artifact, version } = await deps.artifacts.publish({
            title: args.title,
            files,
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
