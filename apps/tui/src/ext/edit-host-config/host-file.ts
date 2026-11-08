/** The host's two files the user edits by hand, under its data directory `~/.eta`. */
export const HOST_FILES = ["config.json", "mcp.json"] as const;
export type HostFile = (typeof HOST_FILES)[number];

export function isHostFile(name: string): name is HostFile {
  return (HOST_FILES as readonly string[]).includes(name);
}
