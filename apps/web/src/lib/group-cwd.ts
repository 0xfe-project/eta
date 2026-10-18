import type { Group } from "@/queries/chat";

/**
 * The directory a group works in, as the host answers it.
 *
 * The web's types still come from the old control plane's OpenAPI document (apps/web/redocly.yaml
 * lists it alongside the host's), and that document predates this field. The value is really
 * there — `GET /api/v1/chat` and `POST /api/v1/groups` both carry it — so the honest thing is to
 * read it and say why the cast is needed, rather than to pretend groups have no folder.
 *
 * Empty means "nobody has set one", which is a state the interface has to show (a group created
 * before the field existed, or one made without a project in mind). It is never "wherever this
 * process happens to be".
 *
 * When the web's types are generated from the host's document alone (after the rest of the
 * control plane's routes are ported, P3), this function is the identity and the cast goes.
 */
export function groupCwd(group: Group): string {
  const value = (group as { cwd?: unknown }).cwd;
  return typeof value === "string" ? value : "";
}

/** The last segment of a path, for showing a folder by its name. */
export function folderName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed.length === 0) return path;
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return name.length === 0 ? trimmed : name;
}
