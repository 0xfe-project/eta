import { readFile, stat } from "fs/promises";
import { fileURLToPath } from "url";

// A local file a file manager copied or dragged in reaches the editor as a `file:` URL, without
// its bytes. NSH's `fetch` answers only `http(s):`, `data:`, `blob:` and `asset:` URLs (a `file:`
// one rejects with "unsupported URL scheme"), so the file is read from disk, under the client's
// `fs.read` grant (nsh.json).

/** The media type of a file by its name, for the common kinds; "" when it says none. */
const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  heic: "image/heic",
  tif: "image/tiff",
  tiff: "image/tiff",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  pdf: "application/pdf",
  zip: "application/zip",
  json: "application/json",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  html: "text/html",
};

function typeByName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : (TYPES[name.slice(dot + 1).toLowerCase()] ?? "");
}

/** The file's name, from its URL's last segment. */
export function nameOfUri(uri: string): string {
  const last = uri.split(/[/\\]/).pop() || "file";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * The file `uri` names, with its bytes; a folder, or a file larger than `limit`, unread. Rejects
 * when it cannot be read: missing, or outside what the app may read.
 */
export async function readUri(
  uri: string,
  limit: number,
): Promise<{ kind: "file"; file: File } | { kind: "folder" | "tooLarge" }> {
  const name = nameOfUri(uri);
  const path = fileURLToPath(uri);
  const info = await stat(path);
  if (info.isDirectory()) return { kind: "folder" };
  if (info.size > limit) return { kind: "tooLarge" };
  const bytes = await readFile(path);
  return {
    kind: "file",
    file: new File([bytes], name, { type: typeByName(name) }),
  };
}
