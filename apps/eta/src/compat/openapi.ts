/**
 * The product API's OpenAPI document (REFACTOR.md §9, P2.5).
 *
 * Written from the zod schemas in `schemas.ts`, which the compiler has already checked against the
 * types the translator produces — so the document cannot describe something the host does not
 * answer. It is served at `/api/v1/openapi.json` and written to a file by `bun run openapi`, which
 * is what the web's `generate` reads to produce its client types.
 *
 * The route table below is the one place the product's surface is written down. A test compares it
 * with the routes the host actually registered, because a document that lists an endpoint nobody
 * answers is worse than no document.
 */
// The default export is zod's `z` namespace, and it is the one import of it that survives
// both runtimes: under vite (the tests) the named `z` comes back undefined, and under bun it
// is the namespace object either way.
import z from "zod";
import {
  agentDeletedSchema,
  agentDraftSchema,
  agentListSchema,
  agentSchema,
  agentUpdatedSchema,
  answerSchema,
  artifactListSchema,
  artifactSchema,
  artifactShareSchema,
  artifactVersionSchema,
  assigneeOptionSchema,
  blockSchema,
  commentInSchema,
  errorSchema,
  groupChangesSchema,
  groupInSchema,
  groupSchema,
  groupUpdatedSchema,
  interactionListSchema,
  interactionSchema,
  interactionUpdatedSchema,
  memberInSchema,
  messagePageSchema,
  messageSchema,
  messageUpdatedSchema,
  readInSchema,
  sendSchema,
  sentSchema,
  snapshotSchema,
  taskActivitySchema,
  taskActorSchema,
  taskAssigneeSchema,
  taskCreatorSchema,
  taskDetailSchema,
  taskInSchema,
  taskListSchema,
  taskSchema,
  taskUpdateSchema,
} from "./schemas";

/**
 * Every shape the document names, by the name a client will see.
 *
 * The names are the product's, not ours: the web imports `Message`, `Snapshot`, `MessageUpdated`
 * and the rest, so a document that only inlined them would generate types nobody could import.
 * The event payloads are here for the same reason — an SSE frame is not a response body, and the
 * client still has to know what one carries.
 */
const CATALOG = {
  Agent: agentSchema,
  AgentDeleted: agentDeletedSchema,
  AgentDraft: agentDraftSchema,
  AgentPatch: agentDraftSchema.partial(),
  BundleList: z.array(z.unknown()),
  PluginList: z.array(z.unknown()),
  Answer: answerSchema,
  AgentList: agentListSchema,
  AgentUpdated: agentUpdatedSchema,
  Artifact: artifactSchema,
  ArtifactList: artifactListSchema,
  ArtifactShare: artifactShareSchema,
  ArtifactVersion: artifactVersionSchema,
  AssigneeOption: assigneeOptionSchema,
  CommentIn: commentInSchema,
  Error: errorSchema,
  Group: groupSchema,
  GroupUpdated: groupUpdatedSchema,
  Interaction: interactionSchema,
  InteractionList: interactionListSchema,
  InteractionUpdated: interactionUpdatedSchema,
  GroupIn: groupInSchema,
  GroupChanges: groupChangesSchema,
  MemberIn: memberInSchema,
  Message: messageSchema,
  MessagePage: messagePageSchema,
  MessageUpdated: messageUpdatedSchema,
  ReadIn: readInSchema,
  Send: sendSchema,
  Sent: sentSchema,
  Snapshot: snapshotSchema,
  Task: taskSchema,
  TaskActivity: taskActivitySchema,
  TaskActor: taskActorSchema,
  TaskAssignee: taskAssigneeSchema,
  TaskCreator: taskCreatorSchema,
  TaskDetail: taskDetailSchema,
  TaskIn: taskInSchema,
  TaskList: taskListSchema,
  TaskUpdateIn: taskUpdateSchema,
  TextBlock: blockSchema,
} as const;

type ShapeName = keyof typeof CATALOG;

export interface ProductRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  summary: string;
  /** Query parameters, as name → description. */
  query?: Record<string, string>;
  body?: ShapeName | { binary: string };
  /** The answer, and the status it comes with; `binary` is a file rather than JSON. */
  response?:
    | { status: number; shape: ShapeName }
    | { status: number; binary: string };
  /** A stream, which is not JSON and is described as such. */
  stream?: boolean;
  /** For a stream: the events it carries, in the product's names. */
  events?: readonly string[];
}

/**
 * What this surface answers.
 *
 * Kept next to the handlers in spirit rather than derived from them: a route's shape is a decision
 * (which status, which schema), and the test that compares this list with the registry is what
 * keeps the two honest.
 */
export const PRODUCT_ROUTES: readonly ProductRoute[] = [
  {
    method: "GET",
    path: "/api/v1/openapi.json",
    summary: "This document.",
    response: { status: 200, shape: "Error" },
  },
  {
    method: "GET",
    path: "/api/v1/chat",
    summary:
      "The whole chat as it stands: groups, agents, running replies, open questions.",
    response: { status: 200, shape: "Snapshot" },
  },
  {
    method: "GET",
    path: "/api/v1/chat/stream",
    summary: "Product events over SSE, resumable from a cursor.",
    query: {
      cursor: "Resume after this seq; an expired one answers 410.",
    },
    stream: true,
    events: [
      "MessageUpdated",
      "GroupUpdated",
      "AgentUpdated",
      "AgentDeleted",
      "InteractionUpdated",
    ],
  },
  {
    method: "POST",
    path: "/api/v1/chat/messages",
    summary: "Send a message, joined to a running turn or queued behind it.",
    body: "Send",
    response: { status: 201, shape: "Sent" },
  },
  {
    method: "POST",
    path: "/api/v1/chat/messages/{message_id}/stop",
    summary: "Stop the run behind a reply.",
    response: { status: 200, shape: "Message" },
  },
  {
    method: "GET",
    path: "/api/v1/chat/interactions",
    summary: "Confirmation cards, newest first, answered or not.",
    query: { limit: "How many to return; 100 by default." },
    response: { status: 200, shape: "InteractionList" },
  },
  {
    method: "POST",
    path: "/api/v1/chat/interactions/{interaction_id}/answer",
    summary: "Answer a card. The run that asked continues.",
    body: "Answer",
    response: { status: 200, shape: "Interaction" },
  },
  {
    method: "POST",
    path: "/api/v1/groups",
    summary: "Create a group, with the folder it works in.",
    body: "GroupIn",
    response: { status: 201, shape: "Group" },
  },
  {
    method: "PATCH",
    path: "/api/v1/groups/{group_id}",
    summary: "Rename a group, set its goal or its folder.",
    body: "GroupChanges",
    response: { status: 200, shape: "Group" },
  },
  {
    method: "PUT",
    path: "/api/v1/groups/{group_id}/members/{agent_id}",
    summary: "Invite or remove a member.",
    body: "MemberIn",
    response: { status: 200, shape: "Group" },
  },
  {
    method: "POST",
    path: "/api/v1/groups/{group_id}/read",
    summary: "Mark a group's messages as read, up to seq.",
    body: "ReadIn",
    response: { status: 200, shape: "Group" },
  },
  {
    method: "POST",
    path: "/api/v1/groups/{group_id}/stop",
    summary: "Stop this group's replies.",
  },
  {
    method: "GET",
    path: "/api/v1/groups/{group_id}/messages",
    summary: "One page of a group's timeline, newest page first.",
    query: {
      before: "The seq to page back from; the newest page when absent.",
    },
    response: { status: 200, shape: "MessagePage" },
  },
  {
    method: "GET",
    path: "/api/v1/artifacts",
    summary: "Static sites that have been published.",
    query: { group_id: "Only this group's.", task_id: "Only this task's." },
    response: { status: 200, shape: "ArtifactList" },
  },
  {
    method: "GET",
    path: "/api/v1/artifacts/{artifact_id}",
    summary:
      "One artifact with its versions, their preview addresses and their shares.",
    response: { status: 200, shape: "Artifact" },
  },
  {
    method: "DELETE",
    path: "/api/v1/artifacts/{artifact_id}",
    summary: "Remove an artifact and its bytes.",
  },
  {
    method: "PUT",
    path: "/api/v1/artifacts/{artifact_id}/versions/{number}/share",
    summary:
      "Share a version publicly. A revoked link is never un-revoked; this mints a new one.",
    response: { status: 200, shape: "ArtifactShare" },
  },
  {
    method: "DELETE",
    path: "/api/v1/artifacts/{artifact_id}/versions/{number}/share",
    summary: "Revoke a version's public link.",
  },
  {
    method: "GET",
    path: "/api/v1/artifacts/{artifact_id}/versions/{number}/archive",
    summary: "Download a version's package.",
    response: { status: 200, binary: "application/zip" },
  },
  {
    method: "POST",
    path: "/artifacts/v1/upload",
    summary: "Publish a ZIP: a new artifact, or a new version of one.",
    query: {
      title: "What it is called.",
      task: "The task it belongs to, when it is for one.",
      group: "The group it came from.",
      artifact: "Add a version to this artifact instead of creating one.",
      agent: "The publishing agent; the tool sends its own.",
    },
    body: { binary: "application/zip" },
    response: { status: 201, shape: "Artifact" },
  },
  {
    method: "GET",
    path: "/api/v1/plugins",
    summary: "The plugins bundles add. Empty until the plugin manager (P3.6).",
    response: { status: 200, shape: "PluginList" },
  },
  {
    method: "GET",
    path: "/api/v1/bundles",
    summary:
      "The bundles agents are built from. Empty until the plugin manager (P3.6).",
    response: { status: 200, shape: "BundleList" },
  },
  {
    method: "GET",
    path: "/api/v1/tasks",
    summary: "The task board, and who work can be assigned to.",
    query: { group_id: "Only this group's tasks." },
    response: { status: 200, shape: "TaskList" },
  },
  {
    method: "POST",
    path: "/api/v1/tasks",
    summary: "Create a task.",
    body: "TaskIn",
    response: { status: 201, shape: "TaskDetail" },
  },
  {
    method: "GET",
    path: "/api/v1/tasks/{task_id}",
    summary: "One task with its timeline.",
    response: { status: 200, shape: "TaskDetail" },
  },
  {
    method: "PATCH",
    path: "/api/v1/tasks/{task_id}",
    summary: "Change a task: only the fields given change.",
    body: "TaskUpdateIn",
    response: { status: 200, shape: "TaskDetail" },
  },
  {
    method: "DELETE",
    path: "/api/v1/tasks/{task_id}",
    summary: "Remove a task. Its cards say it is gone.",
  },
  {
    method: "POST",
    path: "/api/v1/tasks/{task_id}/comments",
    summary: "Comment on a task.",
    body: "CommentIn",
    response: { status: 201, shape: "TaskDetail" },
  },
  {
    method: "POST",
    path: "/api/v1/groups/{group_id}/drafts/{message_id}/confirm",
    summary:
      "Confirm a task draft: the board gets a task, the message becomes its card.",
    body: "TaskIn",
    response: { status: 201, shape: "TaskDetail" },
  },
  {
    method: "GET",
    path: "/api/v1/agents",
    summary: "The agents this host knows.",
    response: { status: 200, shape: "AgentList" },
  },
  {
    method: "POST",
    path: "/api/v1/agents",
    summary: "Create an agent.",
    body: "AgentDraft",
    response: { status: 201, shape: "Agent" },
  },
  {
    method: "PATCH",
    path: "/api/v1/agents/{agent_id}",
    summary: "Change an agent.",
    body: "AgentPatch",
    response: { status: 200, shape: "Agent" },
  },
  {
    method: "DELETE",
    path: "/api/v1/agents/{agent_id}",
    summary: "Delete an agent.",
  },
  {
    method: "POST",
    path: "/api/v1/agents/{agent_id}/direct",
    summary: "The conversation this agent has for itself, created if needed.",
    response: { status: 200, shape: "Group" },
  },
  {
    method: "POST",
    path: "/api/v1/agents/{agent_id}/restart",
    summary:
      "Restart an agent's containers. Nothing here runs in one, so this answers 501.",
  },
];

const jsonSchema = (schema: z.ZodType): Record<string, unknown> =>
  z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "output",
    // Inlined rather than `$ref`-ed into `$defs` inside a component: a client that follows
    // `#/components/schemas/Message` should arrive at the shape, not at another hop.
    reused: "inline",
  }) as Record<string, unknown>;

/** A reference to a named shape in `components`. */
const ref = (shape: ShapeName): Record<string, string> => ({
  $ref: `#/components/schemas/${shape}`,
});

export function productDocument(
  options: { url?: string | undefined; version?: string | undefined } = {},
): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of PRODUCT_ROUTES) {
    const answer: Record<string, unknown> = route.stream
      ? {
          "200": {
            // The frames are not a body: what one carries is `events` below, and each of
            // those is a named shape a client can type.
            description:
              `A stream of product events (SSE). Each frame's \`event:\` names one of: ` +
              `${(route.events ?? []).join(", ")}.`,
            content: { "text/event-stream": { schema: { type: "string" } } },
          },
        }
      : route.response === undefined
        ? { "204": { description: "Done." } }
        : "binary" in route.response
          ? {
              [String(route.response.status)]: {
                description: "The file itself.",
                content: {
                  [route.response.binary]: {
                    schema: { type: "string", format: "binary" },
                  },
                },
              },
            }
          : {
              [String(route.response.status)]: {
                description: "OK",
                content: {
                  "application/json": { schema: ref(route.response.shape) },
                },
              },
            };
    // Every route can refuse, and how it refuses is part of the contract.
    answer["4XX"] = {
      description: "Refused.",
      content: { "application/json": { schema: ref("Error") } },
    };
    const entry: Record<string, unknown> = {
      summary: route.summary,
      ...(route.query === undefined
        ? {}
        : {
            parameters: Object.entries(route.query).map(
              ([name, description]) => ({
                name,
                in: "query",
                required: false,
                description,
                schema: { type: "string" },
              }),
            ),
          }),
      ...(route.body === undefined
        ? {}
        : {
            requestBody: {
              required: true,
              content:
                typeof route.body === "string"
                  ? { "application/json": { schema: ref(route.body) } }
                  : {
                      [route.body.binary]: {
                        schema: { type: "string", format: "binary" },
                      },
                    },
            },
          }),
      responses: answer,
    };
    paths[route.path] = {
      ...(paths[route.path] ?? {}),
      [route.method.toLowerCase()]: entry,
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "eta product API",
      // The document is generated from the code that answers these routes, so its version is
      // the host's own.
      version: options.version ?? "0.0.0",
      description:
        "The API the web speaks. Shapes are AXP's; the rows behind them are this host's.",
    },
    ...(options.url === undefined ? {} : { servers: [{ url: options.url }] }),
    paths,
    components: {
      schemas: Object.fromEntries(
        Object.entries(CATALOG).map(([name, schema]) => [
          name,
          jsonSchema(schema),
        ]),
      ),
    },
  };
}
