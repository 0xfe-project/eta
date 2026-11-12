import type { Registry } from "./registry";
import type { ShellContext } from "./types";
import { missingOps } from "../connection/ops";
import { defineMessages, translatorFor } from "../i18n/messages";

export const commandLineMessages = defineMessages({
  en: {
    unknown: "Unknown command /{name}",
    tooOld: "This host is too old for /{name} (missing {ops})",
    failed: "/{name} failed: {error}",
  },
  zh: {
    unknown: "未知命令 /{name}",
    tooOld: "host 版本太旧，不支持 /{name}（缺 {ops}）",
    failed: "/{name} 出错：{error}",
  },
});

/** Splits `/name rest` into the name and the trimmed rest; undefined when the text does not start with `/`. */
export function parseCommandLine(
  text: string,
): { name: string; argText: string } | undefined {
  if (!text.startsWith("/")) return undefined;
  const body = text.slice(1);
  const space = body.search(/\s/);
  if (space === -1) return { name: body, argText: "" };
  return { name: body.slice(0, space), argText: body.slice(space).trim() };
}

/**
 * Runs a typed command line. An unknown command, one the host lacks an op for, and one whose
 * `run` throws are reported in the status area; none of them throws to the caller.
 */
export async function runCommandLine(
  line: string,
  registry: Registry,
  ctx: ShellContext,
): Promise<void> {
  const parsed = parseCommandLine(line);
  if (!parsed) return;
  const t = translatorFor(commandLineMessages, ctx.locale);
  const command = registry.command(parsed.name);
  if (!command) {
    ctx.notify(t("unknown", { name: parsed.name }), "error");
    return;
  }
  const missing = missingOps(
    ctx.wire.store.getState().ops,
    command.requiredOps,
  );
  if (missing.length > 0) {
    ctx.notify(
      t("tooOld", { name: command.name, ops: missing.join(", ") }),
      "error",
    );
    return;
  }
  try {
    await command.run(ctx, parsed.argText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.notify(t("failed", { name: command.name, error: message }), "error");
  }
}
