import type { TaskActor } from "@eta/client-contracts";
import type { KernelTool } from "@eta/core";
/**
 * Artifacts from a session: `publish_artifact`, and the read-only `search_artifacts` and
 * `read_artifact` (`reading.ts` says what each session may see).
 *
 * The directory is read from this machine's disk, relative to the session's working directory. What
 * is packed is judged by the service (`kinds/site.ts`) and stored as a new version. A version published
 * for a task goes on the task's timeline and into its cards.
 *
 * A task's session is held in a key, not in a conversation (`session-owner.ts`), so what it
 * publishes is for its task, and comes from the conversation the task is in, if it is in one.
 */
import type { SessionHooks } from "../session-hooks";
import type { TaskBoard } from "../tasks/board";
import type { SiteLimits } from "./files";
import type { ArtifactService } from "./service";
import { defineTool, text, toKernelTool, toolError } from "@eta/harness";
import { Type } from "typebox";
import { heldIn, taskOf } from "../session-owner";
import { ArtifactError, collectSite } from "./files";
import {
  conversationOfTask,
  readArtifact,
  scopeOf,
  SEARCH_LIMIT,
  SEARCH_LIMIT_MAX,
  searchArtifacts,
  searchLine,
  taskInScope,
} from "./reading";

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

const searchParameters = () =>
  Type.Object({
    query: Type.Optional(
      Type.String({
        description:
          "Words to find in titles and in the newest version's text, ignoring case. Leave it out to list the newest artifacts",
      }),
    ),
    task: Type.Optional(
      Type.String({
        description:
          "Only the artifacts of this task: its number (12 or #12) or id",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        description: `How many to return: ${SEARCH_LIMIT} by default, at most ${SEARCH_LIMIT_MAX}`,
        minimum: 1,
      }),
    ),
  });

const readParameters = () =>
  Type.Object({
    artifactId: Type.String({
      description: "The artifact: its id, or its exact title",
    }),
    version: Type.Optional(
      Type.Integer({
        description: "Which version; the newest by default",
        minimum: 1,
      }),
    ),
    path: Type.Optional(
      Type.String({
        description:
          "The file in the version, as listed in the result's header; its entry page (usually index.html) by default",
      }),
    ),
    offset: Type.Optional(
      Type.Integer({
        description: "The first line to read, from 1; 1 by default",
        minimum: 1,
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        description: "How many lines to read; 400 by default",
        minimum: 1,
      }),
    ),
  });

export function artifactSessionTools(deps: {
  artifacts: ArtifactService;
  board: TaskBoard;
  limits: SiteLimits;
  /** The task a run is an attempt at, for a session held in a run's key. */
  taskOfRun: (runId: string) => string | undefined;
  /** Captain sees every artifact. */
  isCaptain: (agentId: string) => boolean;
  /** An agent's name, for who published what. */
  agentName: (agentId: string) => string | undefined;
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
          const ownId = taskOf(conversationId, deps.taskOfRun);
          const own = ownId === undefined ? undefined : deps.board.find(ownId);
          const held = heldIn(conversationId);
          // A routine run is held in no conversation, and has none to file it under.
          const where =
            held === "task"
              ? own === undefined
                ? undefined
                : conversationOfTask(own)
              : held === "routine"
                ? undefined
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

    // Who the session is decides what it sees, read at each call: a task can move.
    const scope = () =>
      scopeOf(conversationId, agentId, {
        isCaptain: deps.isCaptain,
        findTask: (id) => deps.board.find(id),
        taskOfRun: deps.taskOfRun,
      });
    const reading = {
      artifacts: deps.artifacts,
      findTask: (id: string) => deps.board.find(id),
      agentName: deps.agentName,
    };

    const search = defineTool<Context, ReturnType<typeof searchParameters>>({
      name: "search_artifacts",
      label: "search_artifacts",
      description:
        "Find published artifacts you can see: those of this conversation and of the tasks in " +
        "it (a task's session sees the conversation its task is in). `query` matches titles and " +
        "the text of the newest version's files (HTML without its tags), ignoring case; without " +
        "it, the newest artifacts are listed. Each line gives the id, title, newest version, " +
        "when it was updated, who published it, its task and the matching text. Read one with " +
        "read_artifact.",
      parameters: searchParameters(),
      async execute(args) {
        try {
          const where = scope();
          let taskId: string | undefined;
          if (args.task !== undefined) {
            const task = deps.board.find(args.task);
            // A task out of scope is not there either: its number says nothing.
            if (task === undefined || !taskInScope(task, where))
              throw new ArtifactError(`no such task: ${args.task}`);
            taskId = task.id;
          }
          const limit = Math.min(
            SEARCH_LIMIT_MAX,
            Math.max(1, Math.floor(args.limit ?? SEARCH_LIMIT)),
          );
          const hits = await searchArtifacts(reading, where, {
            query: args.query,
            taskId,
            limit,
          });
          if (hits.length === 0)
            return text(
              args.query === undefined || args.query.trim() === ""
                ? "No artifacts."
                : `No artifact matches "${args.query}".`,
              { count: 0 },
            );
          return text(hits.map(searchLine).join("\n"), {
            count: hits.length,
          });
        } catch (error) {
          if (error instanceof ArtifactError) return toolError(error.message);
          throw error;
        }
      },
    });

    const read = defineTool<Context, ReturnType<typeof readParameters>>({
      name: "read_artifact",
      label: "read_artifact",
      description:
        "Read a file of a published artifact you can see (search_artifacts finds them). The " +
        "result starts with the artifact's title, version, publisher, task and its files. A " +
        "text file comes as its source with line numbers (HTML as HTML), `limit` lines from " +
        "`offset`; an image comes as an image you can look at; other files only say their size.",
      parameters: readParameters(),
      async execute(args) {
        try {
          return await readArtifact(reading, scope(), args);
        } catch (error) {
          if (error instanceof ArtifactError) return toolError(error.message);
          throw error;
        }
      },
    });

    return [
      toKernelTool(publish, contextOf),
      toKernelTool(search, contextOf),
      toKernelTool(read, contextOf),
    ] as KernelTool[];
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
