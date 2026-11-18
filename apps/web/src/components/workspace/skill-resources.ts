import type { SkillFileContent, SkillTarget } from "@eta/client-contracts";
import { SKILL_FILE_LIMITS } from "@eta/client-contracts";
import { skillCall } from "@/queries/skills";

/** Browser URLs are never interpreted as local FS paths. Relative links stay inside this skill. */
export function skillLink(
  file: string,
  raw: string,
):
  | { kind: "external"; url: string }
  | { kind: "file"; path: string; anchor: string }
  | { kind: "blocked" } {
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      return { kind: "external", url: url.href };
    } catch {
      return { kind: "blocked" };
    }
  }
  if (!raw || /^[/\\]|^[a-z][a-z0-9+.-]*:/i.test(raw))
    return { kind: "blocked" };
  const [pathname, hash = ""] = raw.split("#");
  let decoded: string;
  let anchor: string;
  try {
    decoded = decodeURIComponent(pathname!);
    anchor = decodeURIComponent(hash);
  } catch {
    return { kind: "blocked" };
  }
  if (
    /[\\?]/.test(decoded) ||
    [...decoded].some((character) => character.charCodeAt(0) < 32) ||
    /^\/|^[a-z][a-z0-9+.-]*:/i.test(decoded)
  )
    return { kind: "blocked" };
  if (!decoded) return { kind: "file", path: file, anchor };
  const parts = file.split("/").slice(0, -1);
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return { kind: "blocked" };
      parts.pop();
    } else parts.push(part);
  }
  return parts.length
    ? { kind: "file", path: parts.join("/"), anchor }
    : { kind: "blocked" };
}

/** One open detail owns requests and object URLs. Closing prevents late reads retaining resources. */
export class SkillResources {
  readonly #files = new Map<string, Promise<SkillFileContent>>();
  readonly #urls = new Map<string, string>();
  #bytes = 0;
  #readBytes = 0;
  #closed = false;
  constructor(
    readonly target: SkillTarget,
    readonly detail: string,
  ) {}
  read(path: string): Promise<SkillFileContent> {
    const known = this.#files.get(path);
    if (known) return known;
    const promise = skillCall("read", this.target, {
      detail: this.detail,
      path,
    }).then(({ result }) => {
      if (this.#closed) throw new Error("skill_files:detail_expired");
      if (result.kind === "image") {
        if (
          result.size > SKILL_FILE_LIMITS.imageBytes ||
          result.width * result.height > SKILL_FILE_LIMITS.imagePixels ||
          this.#readBytes + result.size > SKILL_FILE_LIMITS.imageBytes
        )
          throw new Error("skill_files:image_limit");
        this.#readBytes += result.size;
      } else this.#files.delete(path);
      return result;
    });
    this.#files.set(path, promise);
    // Retry explicitly after a failed read, not a permanently rejected cache entry.
    void promise.catch(() => this.#files.delete(path));
    return promise;
  }
  forget(path: string) {
    this.#files.delete(path);
  }
  image(
    path: string,
    content: Extract<SkillFileContent, { kind: "image" }>,
  ): string {
    const known = this.#urls.get(path);
    if (known) return known;
    if (
      this.#closed ||
      content.size > SKILL_FILE_LIMITS.imageBytes ||
      this.#bytes + content.size > SKILL_FILE_LIMITS.imageBytes ||
      content.width * content.height > SKILL_FILE_LIMITS.imagePixels
    )
      throw new Error("skill_files:image_limit");
    const bytes = Uint8Array.from(atob(content.base64), (c) => c.charCodeAt(0));
    if (
      bytes.length !== content.size ||
      !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
        content.mime,
      )
    )
      throw new Error("skill_files:invalid_image");
    const url = URL.createObjectURL(new Blob([bytes], { type: content.mime }));
    this.#bytes += bytes.length;
    this.#urls.set(path, url);
    return url;
  }
  dispose() {
    this.#closed = true;
    for (const url of this.#urls.values()) URL.revokeObjectURL(url);
    this.#urls.clear();
    this.#files.clear();
    return skillCall("close", this.target, { detail: this.detail });
  }
}
