/**
 * `show_widget`: a small UI the agent draws in the conversation, beside its reply (generative UI).
 *
 * The model writes a json-render spec as JSONL patch lines (`@eta/client-contracts/widget` holds
 * the catalog and the prompt). The web page draws the lines while the call streams, from its
 * arguments; once the call is checked here, the spec goes in the result's `details`, which is what
 * a finished reply keeps of it (its arguments are cut short on the row).
 */
import type { KernelTool } from "@eta/core";
import type { SessionHooks } from "../session-hooks";
import {
  widgetCatalog,
  widgetProblems,
  widgetSpec,
} from "@eta/client-contracts/widget";
import { defineTool, text, toKernelTool, toolError } from "@eta/harness";
import { Type } from "typebox";

/** The biggest spec kept, as JSON: a reply's row keeps `details` up to 70KB, with room to spare. */
const MAX_SPEC = 60_000;

const showWidget = defineTool({
  name: "show_widget",
  label: "show_widget",
  description: widgetCatalog.prompt(),
  parameters: Type.Object({
    title: Type.String({
      description: "What the widget shows, in a few words",
    }),
    spec: Type.String({
      description: "The widget as JSONL patch lines, one operation per line",
    }),
  }),
  execute(args) {
    const spec = widgetSpec(args.spec);
    const problems = widgetProblems(spec);
    if (problems.length > 0)
      return toolError(
        `The widget was not drawn:\n${problems.slice(0, 10).join("\n")}`,
      );
    if (JSON.stringify(spec).length > MAX_SPEC)
      return toolError(
        `The widget was not drawn: it is larger than ${MAX_SPEC} characters. Show less.`,
      );
    return text(`Drew "${args.title}".`, { title: args.title, spec });
  },
});

export function widgetSessionTools(): NonNullable<
  SessionHooks["sessionTools"]
> {
  const tools = [toKernelTool(showWidget, () => ({}))] as KernelTool[];
  return () => tools;
}
