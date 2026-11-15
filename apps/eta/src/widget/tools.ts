/**
 * Generative UI: `visualize_read_me` and `show_widget`.
 *
 * The model reads the guidelines for what it is about to draw, then writes an HTML or SVG fragment
 * as `show_widget`'s `widget_code`. The web page draws the fragment in a sandboxed frame while the
 * call streams, from its arguments; once the call lands here, the code goes in the result's
 * `details`, which is what a finished reply keeps of it (its arguments are cut short on the row).
 */
import type { KernelTool } from "@eta/core";
import type { SessionHooks } from "../session-hooks";
import { defineTool, text, toKernelTool, toolError } from "@eta/harness";
import { Type } from "typebox";
import { WIDGET_MODULES, widgetGuidelines } from "./guidelines";

/** The biggest widget kept: a reply's row keeps `details` up to 70KB, with room to spare. */
const MAX_CODE = 60_000;

const readMe = defineTool({
  name: "visualize_read_me",
  label: "visualize_read_me",
  description:
    "Returns the guidelines for show_widget: layout, colours, libraries and patterns. Call it " +
    "once before your first show_widget in a conversation, with the modules that fit what you " +
    "are about to draw. It is a setup step: do not mention it to the user.",
  parameters: Type.Object({
    modules: Type.Array(
      Type.Union(WIDGET_MODULES.map((name) => Type.Literal(name))),
      { description: "Which modules to load; pick all that fit." },
    ),
  }),
  execute(args) {
    return text(widgetGuidelines(args.modules));
  },
});

const showWidget = defineTool({
  name: "show_widget",
  label: "show_widget",
  description:
    "Draw visual content in the conversation, under your reply: an SVG diagram, a chart, a " +
    "dashboard or an interactive HTML explainer. It is drawn while you write it and its " +
    "scripts run when it is complete. Use it when the answer is easier to see than to read. " +
    "For a page the user keeps, shares or downloads, use publish_artifact instead. " +
    "Only the web chat draws it; elsewhere the user sees its title. Call visualize_read_me " +
    `first. At most ${MAX_CODE / 1000}KB.`,
  parameters: Type.Object({
    i_have_seen_read_me: Type.Boolean({
      description: "You called visualize_read_me in this conversation",
    }),
    title: Type.String({ description: "What it shows, in a few words" }),
    widget_code: Type.String({
      description:
        "An HTML fragment (no doctype, html, head or body): style, then markup, then scripts. " +
        "Or an SVG starting with <svg>.",
    }),
  }),
  execute(args) {
    if (!args.i_have_seen_read_me)
      return toolError(
        "Call visualize_read_me first, then show_widget with i_have_seen_read_me: true.",
      );
    if (args.widget_code.length > MAX_CODE)
      return toolError(
        `The widget was not drawn: it is larger than ${MAX_CODE / 1000}KB. Show less.`,
      );
    return text(`Drew "${args.title}" under your reply.`, {
      title: args.title,
      widget_code: args.widget_code,
    });
  },
});

export function widgetSessionTools(): NonNullable<
  SessionHooks["sessionTools"]
> {
  const tools = [
    toKernelTool(readMe, () => ({})),
    toKernelTool(showWidget, () => ({})),
  ] as KernelTool[];
  return () => tools;
}
