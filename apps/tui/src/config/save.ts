/** Writing `tui.json`: only ever the `connection` key, and never over a file it cannot read. */
import type { ConnectionSetting, SaveProblem } from "./types";
import { readFile, stat } from "node:fs/promises";
import { withoutByteOrderMark } from "./load";
import { messageOf, writeFileAtomically } from "./write-file";

const isMissing = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === "ENOENT";

/** The setting as it is written: a resident host without a token has no `token` key. */
function written(setting: ConnectionSetting): ConnectionSetting {
  if (setting.mode === "temporary") return { mode: "temporary" };
  return setting.token === undefined
    ? { mode: "resident", url: setting.url }
    : { mode: "resident", url: setting.url, token: setting.token };
}

/**
 * Save the connection, leaving every other key and their order as they are; the file and its
 * directory are made when missing. A file that is not a JSON object is left alone
 * (`invalid-json`), so nothing the user wrote is lost. Never throws: IO failures come back as
 * `io`.
 */
export async function saveConnection(
  file: string,
  setting: ConnectionSetting,
): Promise<SaveProblem | undefined> {
  let settings: Record<string, unknown> = {};
  try {
    const text = await readFile(file, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(withoutByteOrderMark(text));
    } catch {
      return { reason: "invalid-json", file };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return { reason: "invalid-json", file };
    settings = parsed as Record<string, unknown>;
  } catch (error) {
    if (!isMissing(error))
      return { reason: "io", file, detail: messageOf(error) };
  }
  settings.connection = written(setting);
  try {
    await writeFileAtomically(file, `${JSON.stringify(settings, null, 2)}\n`);
  } catch (error) {
    return { reason: "io", file, detail: messageOf(error) };
  }
  return undefined;
}

/** Make an empty settings file (`{}`) when there is none; an existing file is left as it is. */
export async function ensureConfigFile(
  file: string,
): Promise<SaveProblem | undefined> {
  try {
    await stat(file);
    return undefined;
  } catch (error) {
    if (!isMissing(error))
      return { reason: "io", file, detail: messageOf(error) };
  }
  try {
    await writeFileAtomically(file, "{}\n");
  } catch (error) {
    return { reason: "io", file, detail: messageOf(error) };
  }
  return undefined;
}
