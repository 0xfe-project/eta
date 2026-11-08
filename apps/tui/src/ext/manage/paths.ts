/**
 * The path of `name` inside the directory `path`, on the host's machine: joined with the separator
 * the path already uses, so a Windows path stays one.
 */
export function childPath(path: string, name: string): string {
  const separator = path.includes("/") || !path.includes("\\") ? "/" : "\\";
  return path.endsWith(separator)
    ? `${path}${name}`
    : `${path}${separator}${name}`;
}
