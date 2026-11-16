/**
 * MCP elicitation (`elicitation/create`, 2025-06-18) through the session's ask channel.
 *
 * A server asks the user for input, or for their consent, in the middle of a tool call. This turns
 * that request into the question cards a session already shows (the same ones `ask_user` makes),
 * so nothing new is drawn: a first card carries the server's message and lets the user go on or
 * decline; then one card per field: choices as buttons, yes/no for a boolean, a text box for text
 * and numbers (`-` skips an optional one). Giving up on any card, or nobody answering before the call is
 * aborted, is `cancel`; choosing Decline is `decline`; reaching the end is `accept` with the values.
 *
 * The copy keeps to what the spec says this is: a request for input or consent. It is not an
 * authorisation, and accepting a form is not approving a destructive action, so no card says
 * "approve".
 */

import type { AskRegistry, AskResponse } from "./ask";

/** What the server sent, as the MCP client hands it over. */
export interface ElicitRequest {
  server: string;
  /** `message`, `requestedSchema` and, from later revisions, `mode`. */
  params: Record<string, unknown>;
  signal: AbortSignal | undefined;
}

export type ElicitValue = string | number | boolean | string[];

export type ElicitResult =
  | { action: "accept"; content: Record<string, ElicitValue> }
  | { action: "decline" }
  | { action: "cancel" };

/** One property of a requested schema: the flat, primitive shapes the spec allows. */
interface FieldSchema {
  type?: string;
  title?: string;
  description?: string;
  enum?: unknown[];
  enumNames?: unknown[];
  oneOf?: { const?: unknown; title?: unknown }[];
  items?: { enum?: unknown[]; anyOf?: { const?: unknown; title?: unknown }[] };
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  default?: unknown;
}

export const ELICIT_CONTINUE = "Continue";
export const ELICIT_ACCEPT = "Accept";
export const ELICIT_DECLINE = "Decline";
const YES = "Yes";
/** Typed into an optional field's text box, leaves the field out. */
const SKIP = "-";
const NO = "No";
/** A field typed wrong is asked again, a few times, before the whole request is cancelled. */
const ATTEMPTS = 3;

/** The choices of an enum field: what the card shows, and the value each one stands for. */
function choicesOf(
  field: FieldSchema,
): { label: string; value: string }[] | undefined {
  if (Array.isArray(field.oneOf) && field.oneOf.length > 0)
    return field.oneOf.map((option) => ({
      value: String(option.const),
      label: String(option.title ?? option.const),
    }));
  if (Array.isArray(field.enum) && field.enum.length > 0)
    return field.enum.map((value, index) => ({
      value: String(value),
      label: String(field.enumNames?.[index] ?? value),
    }));
  const items = field.items;
  if (field.type === "array" && items !== undefined) {
    if (Array.isArray(items.anyOf))
      return items.anyOf.map((option) => ({
        value: String(option.const),
        label: String(option.title ?? option.const),
      }));
    if (Array.isArray(items.enum))
      return items.enum.map((value) => ({
        value: String(value),
        label: String(value),
      }));
  }
  return undefined;
}

/** The text the user gave: typed into a card with no options, or picked. */
function answerText(response: AskResponse): string | undefined {
  if (response.kind === "freeform") return response.text;
  if (response.kind === "selection") return response.selections[0];
  return undefined;
}

/** A typed answer as the field's type, or why it is not one. */
function parseTyped(
  field: FieldSchema,
  text: string,
): { value: ElicitValue } | { error: string } {
  const trimmed = text.trim();
  if (field.type === "number" || field.type === "integer") {
    const value = Number(trimmed);
    if (trimmed === "" || !Number.isFinite(value))
      return { error: "Expected a number." };
    if (field.type === "integer" && !Number.isInteger(value))
      return { error: "Expected a whole number." };
    if (field.minimum !== undefined && value < field.minimum)
      return { error: `Expected at least ${field.minimum}.` };
    if (field.maximum !== undefined && value > field.maximum)
      return { error: `Expected at most ${field.maximum}.` };
    return { value };
  }
  if (field.minLength !== undefined && text.length < field.minLength)
    return { error: `Expected at least ${field.minLength} characters.` };
  if (field.maxLength !== undefined && text.length > field.maxLength)
    return { error: `Expected at most ${field.maxLength} characters.` };
  return { value: text };
}

/**
 * Asks the user what an MCP server wants to know, one question card at a time.
 *
 * `id` makes the cards' question ids (`<id>`, `<id>.<field>`, …); it must be unique in the
 * session. Anything but a form request (a URL request from a later revision) is cancelled, since
 * eta claims only form elicitation.
 */
export async function elicitThroughAsk(
  registry: AskRegistry,
  request: ElicitRequest,
  id: string,
): Promise<ElicitResult> {
  const { params, server } = request;
  if (params.mode !== undefined && params.mode !== "form")
    return { action: "cancel" };
  const signal = request.signal;
  const ask = (
    questionId: string,
    question: string,
    options?: string[],
    multi?: boolean,
  ): Promise<AskResponse> =>
    registry.ask(
      {
        questionId,
        question,
        ...(options === undefined || options.length === 0 ? {} : { options }),
        ...(multi === true ? { multi } : {}),
      },
      signal === undefined ? {} : { signal },
    );

  const message =
    typeof params.message === "string" && params.message.trim() !== ""
      ? params.message.trim()
      : "asks for your input";
  const schema = (params.requestedSchema ?? {}) as {
    properties?: Record<string, FieldSchema>;
    required?: unknown[];
  };
  const fields = Object.entries(schema.properties ?? {});
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.map(String) : [],
  );
  const titleOf = (name: string, field: FieldSchema): string =>
    typeof field.title === "string" && field.title !== "" ? field.title : name;

  // The first card: who is asking and what for. Consent alone (no fields) ends here.
  const [headline, ...rest] = message.split("\n");
  const details = [
    rest.join("\n").trim(),
    fields.length === 0
      ? ""
      : `Asks for: ${fields.map(([name, field]) => titleOf(name, field)).join(", ")}`,
  ].filter((line) => line !== "");
  const opening = await ask(
    id,
    [`MCP server ${server}: ${headline}`, ...details].join("\n"),
    [fields.length === 0 ? ELICIT_ACCEPT : ELICIT_CONTINUE, ELICIT_DECLINE],
  );
  const first = answerText(opening);
  if (first === undefined) return { action: "cancel" };
  if (first === ELICIT_DECLINE) return { action: "decline" };

  const content: Record<string, ElicitValue> = {};
  for (const [index, [name, field]] of fields.entries()) {
    const title = titleOf(name, field);
    const optional = !required.has(name);
    const choices = choicesOf(field);
    const typed = field.type !== "boolean" && choices === undefined;
    const lines = [
      // A card with a text box has no buttons but give-up, so skipping is a typed answer.
      `${title}${!optional ? "" : typed ? ` (optional: answer ${SKIP} to skip)` : " (optional)"}`,
      ...(typeof field.description === "string" && field.description !== ""
        ? [field.description]
        : []),
      ...(field.default === undefined
        ? []
        : [`Default: ${String(field.default)}`]),
    ];
    if (field.type === "boolean") {
      const response = await ask(`${id}.${index}`, lines.join("\n"), [YES, NO]);
      const picked = answerText(response);
      if (picked === undefined) return { action: "cancel" };
      content[name] = picked === YES;
      continue;
    }
    if (choices !== undefined) {
      const multi = field.type === "array";
      const response = await ask(
        `${id}.${index}`,
        lines.join("\n"),
        choices.map((choice) => choice.label),
        multi,
      );
      if (response.kind === "none") return { action: "cancel" };
      const labels =
        response.kind === "selection" ? response.selections : [response.text];
      const values = labels.flatMap((label) => {
        const choice = choices.find((c) => c.label === label);
        return choice === undefined ? [] : [choice.value];
      });
      if (values.length === 0) return { action: "cancel" };
      content[name] = multi ? values : values[0]!;
      continue;
    }
    let error: string | undefined;
    let parsed: ElicitValue | undefined;
    let skipped = false;
    for (
      let attempt = 0;
      attempt < ATTEMPTS && parsed === undefined;
      attempt++
    ) {
      const response = await ask(
        attempt === 0 ? `${id}.${index}` : `${id}.${index}.${attempt}`,
        [...lines, ...(error === undefined ? [] : [error])].join("\n"),
      );
      const text = answerText(response);
      if (text === undefined) return { action: "cancel" };
      if (optional && text.trim() === SKIP) {
        skipped = true;
        break;
      }
      const result = parseTyped(field, text);
      if ("error" in result) error = result.error;
      else parsed = result.value;
    }
    if (parsed !== undefined) content[name] = parsed;
    else if (!skipped) return { action: "cancel" };
  }
  return { action: "accept", content };
}
