/** The last segment of a path, for showing a folder by its name. */
export function folderName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed.length === 0) return path;
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return name.length === 0 ? trimmed : name;
}
