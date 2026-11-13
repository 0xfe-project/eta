/**
 * What an agent can draw in a conversation with `show_widget`: a json-render catalog.
 *
 * The host reads it for the tool's description (the prompt) and to check a finished spec; the web
 * page draws the same component names with its own elements. A spec is a flat tree, written by the
 * model as JSONL patch lines so the page can draw it while it streams.
 */
import type { PromptContext, Spec } from "@json-render/core";
import { compileSpecStream, defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import * as z from "zod";

const tone = z.enum(["neutral", "success", "warning", "error", "info"]);

interface ComponentDef {
  props: z.ZodType;
  slots?: string[];
  description: string;
}

/**
 * The prompt json-render writes by default teaches state, actions, repeats and watchers, which
 * these components do not use, and is sent with every request: this one says only what drawing
 * them takes. The component lines still come from the catalog.
 */
function widgetTemplate({ catalog, formatZodType }: PromptContext): string {
  const components = (catalog as { components: Record<string, ComponentDef> })
    .components;
  const lines = Object.entries(components).map(
    ([name, def]) =>
      `- ${name}: ${formatZodType(def.props)} - ${def.description}${
        def.slots === undefined ? "" : " [accepts children]"
      }`,
  );
  return [
    "Draw a small UI in the conversation, beside your reply: metrics, a comparison, a table, a",
    "checklist, progress. Use it when the answer is easier to see than to read; for prose, code or",
    "a single number, just write. The web chat draws it under your reply; other views show only",
    "this call's title, so the reply still says in a sentence what the widget shows, without",
    "repeating its numbers.",
    "",
    "`spec` is JSONL: one RFC 6902 JSON Patch operation per line, no code fences. Set /root first,",
    "then add each element under /elements/<key>, parents before children, so the widget fills in",
    "as it streams. Each element is {type, props, children}; children lists the keys of its child",
    "elements, and every key listed must be added. Leaves have children: []. Optional props may be",
    "left out.",
    "",
    "Example:",
    '{"op":"add","path":"/root","value":"main"}',
    '{"op":"add","path":"/elements/main","value":{"type":"Card","props":{"title":"Build"},"children":["rate"]}}',
    '{"op":"add","path":"/elements/rate","value":{"type":"Metric","props":{"label":"Pass rate","value":"98%"},"children":[]}}',
    "",
    "Components (only these exist; there is no HTML, CSS or script):",
    ...lines,
    "",
    "Keep it compact: one root, a few sections, nothing decorative. Write its text in the user's",
    "language.",
  ].join("\n");
}

export const widgetCatalog = defineCatalog(
  // `createCatalog` reads the template from the schema it is called on.
  { ...schema, promptTemplate: widgetTemplate },
  {
    components: {
      Stack: {
        props: z.object({
          direction: z.enum(["column", "row"]).nullish(),
          gap: z.enum(["sm", "md", "lg"]).nullish(),
        }),
        slots: ["default"],
        description: "Lays its children out in a column (default) or a row.",
      },
      Grid: {
        props: z.object({ columns: z.number().int().min(1).max(4).nullish() }),
        slots: ["default"],
        description:
          "Equal columns (default 2, at most 4), for metrics or cards side by side.",
      },
      Card: {
        props: z.object({
          title: z.string().nullish(),
          description: z.string().nullish(),
        }),
        slots: ["default"],
        description: "A framed section with an optional title.",
      },
      Heading: {
        props: z.object({ text: z.string() }),
        description: "A section heading.",
      },
      Text: {
        props: z.object({ text: z.string(), muted: z.boolean().nullish() }),
        description: "A paragraph of plain text.",
      },
      Metric: {
        props: z.object({
          label: z.string(),
          value: z.string(),
          detail: z.string().nullish(),
          trend: z.enum(["up", "down", "flat"]).nullish(),
        }),
        description:
          "One number with its label, e.g. a total or a rate; `value` is already formatted.",
      },
      Badge: {
        props: z.object({ text: z.string(), tone: tone.nullish() }),
        description: "A short status label.",
      },
      Progress: {
        props: z.object({
          label: z.string().nullish(),
          value: z.number(),
          max: z.number().nullish(),
        }),
        description: "How far along something is (max defaults to 100).",
      },
      BarChart: {
        props: z.object({
          data: z.array(z.object({ label: z.string(), value: z.number() })),
          unit: z.string().nullish(),
        }),
        description:
          "Horizontal bars comparing a few values (up to about 12 rows).",
      },
      Table: {
        props: z.object({
          columns: z.array(z.string()),
          rows: z.array(z.array(z.union([z.string(), z.number()]))),
        }),
        description: "Rows of values under column headings.",
      },
      List: {
        props: z.object({
          items: z.array(z.string()),
          ordered: z.boolean().nullish(),
        }),
        description: "A bulleted or numbered list.",
      },
      Callout: {
        props: z.object({ text: z.string(), tone: tone.nullish() }),
        description: "A note that stands out: a warning, a tip, a result.",
      },
      Divider: {
        props: z.object({}),
        description: "A thin line between sections.",
      },
    },
    actions: {},
  },
);

/** A spec from its JSONL lines; an unfinished last line is left out, so this reads a stream too. */
export function widgetSpec(lines: string): Spec {
  return compileSpecStream<Spec & Record<string, unknown>>(lines);
}

/**
 * What is wrong with a finished spec, as lines the model can fix it from; none when it draws. The
 * catalog's own check reads the tree's shape, not each component's props, so those are read here.
 */
export function widgetProblems(spec: Spec): string[] {
  const shape = widgetCatalog.validate(spec);
  if (!shape.success)
    return (shape.error?.issues ?? []).map(
      (issue) => `${issue.path.join("/")}: ${issue.message}`,
    );
  if (spec.elements[spec.root] === undefined)
    return [`root "${spec.root}" is not an element`];
  const components = widgetCatalog.data.components as Record<
    string,
    ComponentDef
  >;
  return Object.entries(spec.elements).flatMap(([key, element]) => [
    ...(
      components[element.type]?.props.safeParse(element.props).error?.issues ??
      []
    ).map(
      (issue) =>
        `elements/${key}/props/${issue.path.join("/")}: ${issue.message}`,
    ),
    ...(element.children ?? [])
      .filter((child) => spec.elements[child] === undefined)
      .map((child) => `elements/${key}: child "${child}" is not an element`),
  ]);
}

/** What `show_widget` leaves in its result's `details`, for the page to draw. */
export interface WidgetDetails {
  title: string;
  spec: Spec;
}
