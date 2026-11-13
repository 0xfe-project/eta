/**
 * A feature made of slash commands only, for tests that need to run something inside the shell:
 * open a layer, call the host, keep the shell's context.
 */
import type { Extension, SlashCommand } from "../../src/extensions/types";

/** An extension with one command per entry; every command takes free text and needs no op. */
export function testCommands(
  id: string,
  commands: Record<string, SlashCommand["run"]>,
): Extension {
  return {
    id,
    commands: Object.entries(commands).map(([name, run]) => ({
      name,
      args: [],
      summary: { en: `Test ${name}`, zh: `测试 ${name}` },
      examples: [],
      requiredOps: [],
      run,
    })),
  };
}
