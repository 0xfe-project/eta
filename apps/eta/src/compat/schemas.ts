import type {
  AxpAgent,
  AxpBlock,
  AxpGroup,
  AxpInteraction,
  AxpInteractionOption,
  AxpMessage,
  AxpParticipant,
  AxpSnapshot,
} from "./shapes";
/**
 * The product API's contract, as zod (REFACTOR.md §9, P2.5).
 *
 * `shapes.ts` holds the TypeScript types the translator writes and `toMessage`-style functions
 * produce; this file holds the same shapes as runtime schemas, which is what an OpenAPI document
 * can be generated from. Two descriptions of one thing drift, so the compiler is asked to prove
 * they agree: `agrees<A, B>()` below fails to compile unless the schema's inferred type and the
 * interface are the same in both directions. Adding a field to one side and not the other is a
 * type error, not a surprise at runtime.
 */
// The default export is zod's `z` namespace, and it is the one import of it that survives
// both runtimes: under vite (the tests) the named `z` comes back undefined, and under bun it
// is the namespace object either way.
import z from "zod";

/**
 * A compile-time assertion that two types are the same.
 *
 * `true` when they match in both directions and `never` when they do not, so the declaration below
 * only compiles while the schema and the interface describe the same shape.
 */
type Agrees<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const agrees = <A, B>(_: Agrees<A, B>): void => {
  void _;
};

export const blockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const messageSchema = z.object({
  group_id: z.string(),
  seq: z.number().int(),
  kind: z.enum(["message", "mention", "system", "task_draft", "task_card"]),
  data: z.record(z.string(), z.unknown()),
  id: z.string(),
  agent_id: z.string(),
  role: z.enum(["user", "assistant"]),
  reply_to_id: z.string().nullable(),
  status: z.enum([
    "queued",
    "responding",
    "waiting_for_input",
    "stopping",
    "completed",
    "stopped",
    "failed",
  ]),
  revision: z.number().int(),
  blocks: z.array(blockSchema),
  failure: z.object({ message: z.string() }).nullable(),
  created_at: z.string(),
});

export const participantSchema = z.object({
  agent_id: z.string(),
  member: z.boolean(),
  name: z.string(),
  status: z.string(),
});

export const groupSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["group", "direct"]),
  goal: z.string(),
  decided: z.string(),
  archived: z.boolean(),
  read_seq: z.number().int(),
  last_seq: z.number().int(),
  unread: z.number().int(),
  preview: z.string(),
  revision: z.number().int(),
  last_message_at: z.string().nullable(),
  updated_at: z.string(),
  participants: z.array(participantSchema),
});

export const agentSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  model: z.string().nullable(),
  bundles: z.array(z.string()),
  status: z.enum([
    "idle",
    "starting",
    "working",
    "waiting_for_input",
    "unavailable",
  ]),
  build_error: z.string().nullable(),
  revision: z.number().int(),
});

export const interactionOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
});

export const interactionSchema = z.object({
  group_id: z.string(),
  id: z.string(),
  agent_id: z.string(),
  message_id: z.string(),
  kind: z.literal("choice"),
  prompt: z.string(),
  options: z.array(interactionOptionSchema),
  status: z.enum(["pending", "resolved", "expired"]),
  revision: z.number().int(),
  answer: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const snapshotSchema = z.object({
  groups: z.array(groupSchema),
  agents: z.array(agentSchema),
  active_replies: z.array(messageSchema),
  interactions: z.array(interactionSchema),
  event_cursor: z.string(),
});

export const messagePageSchema = z.object({
  items: z.array(messageSchema),
  next_cursor: z.string().nullable(),
});

export const sentSchema = z.object({
  message: messageSchema,
  replies: z.array(messageSchema),
});

export const interactionListSchema = z.object({
  interactions: z.array(interactionSchema),
});

export const agentListSchema = z.object({
  agents: z.array(agentSchema),
});

/**
 * What the stream's frames carry (P2.5).
 *
 * Not response bodies: a `text/event-stream` frame has no schema slot in OpenAPI. They are named
 * here so a generated client can type what it parses — `event: message.updated` carries a
 * `MessageUpdated`, and that is the whole of the contract.
 */
export const messageUpdatedSchema = z.object({ message: messageSchema });
export const groupUpdatedSchema = z.object({ group: groupSchema });
export const agentUpdatedSchema = z.object({ agent: agentSchema });
export const agentDeletedSchema = z.object({ agent_id: z.string() });
export const interactionUpdatedSchema = z.object({
  interaction: interactionSchema,
});

/** The answer to a confirmation card. */
export const answerSchema = z.object({ value: z.string() });

/** What the host answers with when something is refused. */
export const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    request_id: z.string(),
  }),
});

export const agentDraftSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  model: z.string().optional(),
  bundles: z.array(z.string()).optional(),
});

export const sendSchema = z.object({
  id: z.string().optional(),
  group_id: z.string(),
  mentions: z.array(z.string()).optional(),
  parts: z.array(
    z.object({
      type: z.enum(["text", "attachment"]),
      text: z.string().optional(),
      attachment_id: z.string().optional(),
    }),
  ),
  mode: z.enum(["queue", "steer"]).optional(),
});

// One line per shape, and they only compile while the two descriptions agree.
agrees<z.infer<typeof blockSchema>, AxpBlock>(true);
agrees<z.infer<typeof messageSchema>, AxpMessage>(true);
agrees<z.infer<typeof participantSchema>, AxpParticipant>(true);
agrees<z.infer<typeof groupSchema>, AxpGroup>(true);
agrees<z.infer<typeof agentSchema>, AxpAgent>(true);
agrees<z.infer<typeof interactionOptionSchema>, AxpInteractionOption>(true);
agrees<z.infer<typeof interactionSchema>, AxpInteraction>(true);
agrees<z.infer<typeof snapshotSchema>, AxpSnapshot>(true);
