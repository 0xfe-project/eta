import type { TaskActor } from "@eta/client-contracts";
import type { KernelTool } from "@eta/core";
/**
 * Publishing from a session: the `publish_artifact` tool.
 *
 * The directory is read from this machine's disk, relative to the session's working directory. What
 * is packed is judged by the service (`kinds/site.ts`) and stored as a new version. A version published
 * for a task goes on the task's timeline and into its cards.
 *
 * A task's session is held in a key, not in a conversation (`tasks/session-key.ts`), so what it
 * publishes is for its task, and comes from the conversation the task is in, if it is in one.
 */
import type { SessionHooks } from "../session-hooks";
import type { TaskBoard } from "../tasks/board";
import type { SiteLimits } from "./files";
import type { ArtifactService } from "./service";
import { defineTool, text, toKernelTool, toolError } from "@eta/harness";
import { Type } from "typebox";
import { isTaskSession, taskOfKey } from "../tasks/session-key";
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
          "The artifact to add a version to: its id, which publishing returns, or the exact " +
          "title of one you published in this conversation or for this task",
      }),
    ),
    taskId: Type.Optional(
      Type.String({
        description:
          "The task this is for, by number (12 or #12) or id: it goes on the task's timeline and into its card. A task's own session need not say: it defaults to that task",
      }),
    ),
  });

export function artifactSessionTools(deps: {
  artifacts: ArtifactService;
  board: TaskBoard;
  limits: SiteLimits;
  /** The task a run is an attempt at, for a session held in a run's key. */
  taskOfRun: (runId: string) => string | undefined;
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
        "directory with index.html at its root, plus any CSS, scripts and images. The result " +
        "names the artifact's id. To revise an artifact, publish again with that id as " +
        "`artifactId`: it adds a version to the same artifact instead of making a second one. " +
        "If the id is lost, `artifactId` also takes the exact title of an artifact you published " +
        "in this conversation or for this task. Symbolic links are refused; .git and node_modules are left out. The page " +
        "runs in a sandbox: it can use scripts, but it cannot reach the host's API, cookies or " +
        "anything else of the user's. localStorage, cookies, IndexedDB and Service Workers are " +
        "not available, and there is no backend: only GET requests for the published files.\n\n" +
        "Building for it: the site is served under a path of its own, so use relative asset " +
        "paths. For a Vite project set `base: './'`, run `vite build` yourself and publish " +
        "`dist`. Route with the hash, or set `spa: true` for path routes; with `spa` a root path " +
        "such as `/assets/app.js` in index.html is refused, and the router needs " +
        '`basename={new URL(".", document.baseURI).pathname}`.\n\n' +
        "The user sees the artifact as a card beside your reply, so the reply should not repeat " +
        "it. Say what it is in a line, then only what it does not carry: what failed, what to " +
        "watch for, what needs a decision.",
      parameters: parameters(),
      async execute(args, run) {
        try {
          const task =
            args.taskId === undefined
              ? undefined
              : deps.board.find(args.taskId);
          if (args.taskId !== undefined && task === undefined)
            throw new ArtifactError(`no such task: ${args.taskId}`);
          // Read now, not when the session opened: a task can move to another conversation.
          const ownId = taskOfKey(conversationId, deps.taskOfRun);
          const own = ownId === undefined ? undefined : deps.board.find(ownId);
          const where = isTaskSession(conversationId)
            ? (own?.conversationId ?? own?.originConversationId ?? undefined)
            : conversationId;
          const artifactId =
            args.artifactId === undefined
              ? undefined
              : resolveArtifact(deps.artifacts, args.artifactId, {
                  agentId,
                  conversationId: where,
                  taskId: own?.id,
                });
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
            artifactId,
            taskId: task?.id,
            sessionTaskId: own?.id,
            conversationId: where,
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
            `Published "${artifact.title}" as artifact ${artifact.id}, version ${version.number} ` +
              `(${version.files} files). The user can preview, share and download it. To revise ` +
              `it, publish again with artifactId "${artifact.id}".`,
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

/**
 * What `artifactId` names. An id is taken as it is: whether it may be added to is the service's
 * judgement. Anything else is read as the exact title of an artifact this agent published in this
 * conversation or for this task, so a model that lost the id, to a compaction or a fresh session,
 * can still revise what it made. When nothing matches, the refusal lists what it could have named.
 */
function resolveArtifact(
  artifacts: ArtifactService,
  ref: string,
  scope: {
    agentId: string;
    conversationId: string | undefined;
    taskId: string | undefined;
  },
): string {
  if (artifacts.view(ref) !== undefined) return ref;
  const own = artifacts
    .list()
    .filter(
      (artifact) =>
        artifact.publisherAgentId === scope.agentId &&
        ((scope.conversationId !== undefined &&
          artifact.conversationId === scope.conversationId) ||
          (scope.taskId !== undefined && artifact.taskId === scope.taskId)),
    );
  const title = ref.trim();
  const named = own.filter((artifact) => artifact.title === title);
  if (named.length === 1) return named[0]!.id;
  const listed = (list: typeof own) =>
    list.map((artifact) => `"${artifact.title}" ${artifact.id}`).join("; ");
  if (named.length > 1)
    throw new ArtifactError(
      `several artifacts you published here are titled "${title}"; name one by id: ${listed(named)}`,
    );
  throw new ArtifactError(
    own.length === 0
      ? `no such artifact: ${ref}`
      : `no such artifact: ${ref}. You published here: ${listed(own)}`,
  );
}
