import type { SlashCommand } from "./types";

/** How to type a command: `/name <required> [optional]`. */
export function commandUsage(command: SlashCommand): string {
  const args = command.args.map((arg) =>
    arg.required ? `<${arg.name}>` : `[${arg.name}]`,
  );
  return [`/${command.name}`, ...args].join(" ");
}
