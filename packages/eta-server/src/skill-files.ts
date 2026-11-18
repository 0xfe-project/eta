/** Target-side skill files. Path checks and version checks are not an OS transaction:
 * a malicious same-user writer racing the final check is outside this tool's guarantee.
 */
import type {
  SkillDeletePlan,
  SkillDirectory,
  SkillFileContent,
  SkillFileEntry,
  SkillFileLocation,
  SkillFileRequest,
  SkillFileResult,
  SkillList,
} from "@eta/client-contracts";
import type { Stats } from "node:fs";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { SKILL_FILE_LIMITS as LIMIT } from "@eta/client-contracts";
import {
  detectSupportedImageMimeType,
  parseSkillText,
  readImageSize,
} from "@eta/harness";

function fail(code: string, path: string): never {
  throw new Error(`skill_files:${code}: ${path}`);
}
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException).code;
const identity = (s: Stats) => [s.dev, s.ino, s.birthtimeMs, s.mode];
const stamp = (s: Stats) => [...identity(s), s.size, s.mtimeMs, s.ctimeMs];
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const inside = (root: string, path: string) =>
  path === root ||
  (!relative(root, path).startsWith(`..${sep}`) &&
    relative(root, path) !== ".." &&
    !isAbsolute(relative(root, path)));
function childName(name: string): string {
  if (
    typeof name !== "string" ||
    !name ||
    name === "." ||
    name === ".." ||
    /[\\/:]/.test(name) ||
    [...name].some((char) => char.charCodeAt(0) < 32) ||
    /[. ]$/.test(name)
  )
    fail("invalid_name", String(name));
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))
    fail("invalid_name", name);
  return name;
}
function filePath(root: string, path: string): string {
  if (
    typeof path !== "string" ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.includes(":") ||
    isAbsolute(path)
  )
    fail("invalid_path", String(path));
  const full = resolve(root, path);
  if (!inside(root, full)) fail("outside_skill", path);
  if (relative(root, full).split(sep).filter(Boolean).length > LIMIT.depth)
    fail("depth_limit", path);
  return full;
}
/** Refuse links locally, including internal links. Missing descendants are only allowed on create. */
async function checked(
  base: string,
  path: string,
  missing = false,
): Promise<boolean> {
  if (!inside(base, path)) fail("outside_root", path);
  const realBase = await realpath(base);
  let current = base;
  for (const part of relative(base, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    let info: Stats;
    try {
      info = await lstat(current);
    } catch (error) {
      if (missing && codeOf(error) === "ENOENT") return false;
      throw error;
    }
    if (info.isSymbolicLink()) fail("link_refused", current);
    if (!inside(realBase, await realpath(current)))
      fail("outside_root", current);
  }
  return true;
}
async function writable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch (error) {
    if (["EACCES", "EPERM", "EROFS"].includes(codeOf(error) ?? ""))
      return false;
    throw error;
  }
}
async function bytes(
  path: string,
  max: number,
): Promise<{ data: Buffer; version: string }> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile()) fail("not_regular_file", path);
    if (before.size > max) fail("byte_limit", path);
    const data = Buffer.alloc(Math.min(before.size + 1, max + 1));
    let used = 0;
    while (used < data.length) {
      const read = await handle.read(data, used, data.length - used, null);
      if (read.bytesRead === 0) break;
      used += read.bytesRead;
    }
    if (used > max) fail("byte_limit", path);
    const after = await handle.stat();
    if (
      JSON.stringify(stamp(before)) !== JSON.stringify(stamp(after)) ||
      used !== after.size
    )
      fail("changed", path);
    const content = data.subarray(0, used);
    return {
      data: content,
      version: digest(
        JSON.stringify(identity(await lstat(dirname(path)))) +
          JSON.stringify(stamp(after)) +
          digest(content),
      ),
    };
  } finally {
    await handle.close();
  }
}
function textOf(data: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(data);
}
function metadata(text: string, path: string) {
  const parsed = parseSkillText(text, path, basename(dirname(path)));
  return {
    name: parsed.skill?.name ?? basename(dirname(path)),
    description: parsed.skill?.description ?? "",
    valid: parsed.skill !== null,
    diagnostics: parsed.diagnostics.map((d) => d.message),
    preview: parsed.preview,
  };
}
function validate(text: string, path: string) {
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text, "utf8") > LIMIT.textBytes
  )
    fail("text_limit", path);
  const parsed = metadata(text, path);
  if (!parsed.valid)
    fail("invalid_skill", parsed.diagnostics.join("; ") || path);
  return parsed;
}
interface Detail {
  root: string;
  skill: string;
  identity: string;
  entries: Set<string>;
  images: Map<string, number>;
  touched: number;
}
export class SkillFiles {
  readonly #details = new Map<string, Detail>();
  readonly #home: string;
  constructor(home = homedir()) {
    this.#home = home;
  }

  #writes: Promise<unknown> = Promise.resolve();
  execute(request: SkillFileRequest): Promise<SkillFileResult> {
    if (["create", "save", "delete"].includes(request.action)) {
      const result = this.#writes.then(() => this.#execute(request));
      this.#writes = result.catch(() => undefined);
      return result;
    }
    return this.#execute(request);
  }
  async #execute(request: SkillFileRequest): Promise<SkillFileResult> {
    const { location, args, action } = request;
    if (
      ![
        "list",
        "open",
        "directory",
        "read",
        "close",
        "create",
        "save",
        "planDelete",
        "delete",
      ].includes(action)
    )
      fail("unknown_action", String(action));
    const base = await this.#base(location);
    const root = join(base, ".agents", "skills");
    const exists = await checked(
      base,
      root,
      action === "list" || action === "create",
    );
    if (action === "list")
      return this.#list(base, root, exists, args.offset ?? 0);
    if (action === "create")
      return this.#create(base, root, args.skill, args.text);
    if (!exists) fail("missing_root", root);
    if (action === "close") {
      this.#details.delete(args.detail);
      return {};
    }
    if (action === "open") {
      const skill = join(root, childName(args.skill));
      await this.#skill(base, skill);
      // Entries without SKILL.md are containers/legacy sources, not deletable skills.
      const info = await this.#summary(base, root, {
        path: args.skill,
        kind: "directory",
        size: 0,
      });
      const now = Date.now();
      for (const [key, value] of this.#details)
        if (now - value.touched > 30 * 60_000) this.#details.delete(key);
      if (this.#details.size >= 64) fail("too_many_details", root);
      const detail = randomUUID();
      this.#details.set(detail, {
        root,
        skill,
        identity: JSON.stringify(identity(await lstat(skill))),
        entries: new Set(),
        images: new Map(),
        touched: now,
      });
      return {
        detail,
        path: skill,
        writable: info.writable,
        diagnostics: info.diagnostics,
      };
    }
    if (action === "directory" || action === "read") {
      const detail = this.#details.get(args.detail);
      if (
        !detail ||
        detail.root !== root ||
        Date.now() - detail.touched > 30 * 60_000
      )
        fail("detail_expired", args.detail);
      await this.#skill(base, detail.skill);
      if (
        JSON.stringify(identity(await lstat(detail.skill))) !== detail.identity
      )
        fail("changed", detail.skill);
      detail.touched = Date.now();
      const path = filePath(detail.skill, args.path);
      await checked(base, path);
      if (action === "directory") {
        if (
          relative(detail.skill, path).split(sep).filter(Boolean).length >=
          LIMIT.depth
        )
          fail("depth_limit", path);
        const page = await this.#directory(path, args.offset ?? 0);
        const keys = page.entries.map((e) =>
          relative(detail.skill, join(path, e.path)),
        );
        const additional = keys.filter((k) => !detail.entries.has(k));
        if (detail.entries.size + additional.length > LIMIT.entries)
          fail("entry_limit", path);
        for (const key of keys) detail.entries.add(key);
        return page;
      }
      return this.#read(path, detail);
    }
    const skill = join(root, childName(args.skill));
    await this.#skill(base, skill);
    if (action === "save")
      return this.#save(base, skill, args.text, args.version);
    const plan = await this.#plan(
      base,
      root,
      skill,
      location.scope === "personal",
    );
    if (action === "planDelete") return plan;
    if (plan.version !== args.version) fail("conflict_reconfirm", skill);
    // Recheck immediately before removal. Never follow links and never remove a container/root.
    await checked(base, skill);
    for (const entry of [...plan.entries].reverse()) {
      const path = filePath(skill, entry.path);
      await checked(base, path);
      if (entry.kind === "directory") await rmdir(path);
      else await unlink(path);
    }
    await rmdir(skill);
    return {};
  }
  async #base(location: SkillFileLocation): Promise<string> {
    if (location.home !== this.#home) fail("home_changed", this.#home);
    if (location.scope !== "personal" && location.scope !== "project")
      fail("invalid_scope", String(location.scope));
    const base =
      location.scope === "personal" ? this.#home : location.projectPath;
    if (!base || !isAbsolute(base)) fail("project_required", String(base));
    if (!(await lstat(base)).isDirectory()) fail("not_directory", base);
    return realpath(base);
  }
  async #skill(base: string, skill: string) {
    await checked(base, skill);
    if (!(await lstat(skill)).isDirectory()) fail("not_directory", skill);
  }
  async #directory(path: string, offset: number): Promise<SkillDirectory> {
    if (!Number.isInteger(offset) || offset < 0 || offset >= LIMIT.entries)
      fail("entry_limit", path);
    const entries: SkillFileEntry[] = [];
    let index = 0;
    for await (const entry of await opendir(path)) {
      if (index++ < offset) continue;
      if (entries.length === Math.min(LIMIT.batch, LIMIT.entries - offset))
        return { entries, next: offset + entries.length };
      const info = await lstat(join(path, entry.name));
      const kind =
        info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())
          ? "blocked"
          : info.isDirectory()
            ? "directory"
            : "file";
      entries.push({
        path: entry.name,
        kind,
        size: info.size,
        ...(kind === "blocked" ? { reason: "link_or_special_file" } : {}),
      });
    }
    return { entries, next: null };
  }
  async #summary(base: string, root: string, entry: SkillFileEntry) {
    const summary = {
      ...entry,
      name: entry.path,
      description: "",
      writable: false,
      diagnostics: [] as string[],
    };
    if (entry.kind !== "directory") {
      summary.diagnostics.push("legacy_or_blocked_entry");
      return summary;
    }
    const path = join(root, entry.path, "SKILL.md");
    try {
      await checked(base, path);
      const { data } = await bytes(path, LIMIT.textBytes);
      const parsed = metadata(textOf(data), path);
      Object.assign(summary, {
        name: parsed.name.slice(0, 64),
        description: parsed.description.slice(0, 1024),
        diagnostics: parsed.diagnostics.map((d) => d.slice(0, 2048)),
      });
      summary.writable =
        (await writable(path)) && (await writable(dirname(path)));
    } catch (error) {
      summary.diagnostics.push(
        (error instanceof Error ? error.message : String(error)).slice(0, 2048),
      );
    }
    return summary;
  }
  async #list(
    base: string,
    root: string,
    exists: boolean,
    offset: number,
  ): Promise<SkillList> {
    if (!exists) return { root, exists: false, entries: [], next: null };
    const page = await this.#directory(root, offset);
    const entries = [];
    for (const entry of page.entries)
      entries.push(await this.#summary(base, root, entry));
    return { root, exists: true, entries, next: page.next };
  }
  async #read(path: string, detail: Detail): Promise<SkillFileContent> {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let mime: string | undefined;
    try {
      if (!(await handle.stat()).isFile()) fail("not_regular_file", path);
      const head = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(head, 0, head.length, 0);
      mime = detectSupportedImageMimeType(head.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
    const isImage =
      mime !== undefined &&
      ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime);
    const { data, version } = await bytes(
      path,
      isImage ? LIMIT.imageBytes : LIMIT.textBytes,
    );
    if (isImage && detectSupportedImageMimeType(data) !== mime)
      fail("changed", path);
    if (isImage && mime) {
      const size = readImageSize(data);
      if (!size || size.width <= 0 || size.height <= 0)
        fail("invalid_image", path);
      if (size.width * size.height > LIMIT.imagePixels)
        fail("pixel_limit", path);
      const key = path + version;
      const used = [...detail.images.values()].reduce((a, b) => a + b, 0);
      if (!detail.images.has(key) && used + data.length > LIMIT.imageBytes)
        fail("image_total_limit", path);
      detail.images.set(key, data.length);
      return {
        kind: "image",
        base64: data.toString("base64"),
        mime,
        ...size,
        size: data.length,
      };
    }
    if (data.length > LIMIT.textBytes) fail("text_limit", path);
    let text: string;
    try {
      text = textOf(data);
    } catch {
      return { kind: "unsupported", size: data.length, reason: "invalid_utf8" };
    }
    if (text.includes("\0"))
      return { kind: "unsupported", size: data.length, reason: "binary" };
    const parsed =
      basename(path) === "SKILL.md" ? metadata(text, path) : undefined;
    return {
      kind: "text",
      text,
      ...(parsed?.preview ? { preview: parsed.preview } : {}),
      version,
      size: data.length,
      diagnostics: parsed?.diagnostics ?? [],
    };
  }
  async #create(base: string, root: string, name: string, text: string) {
    const skill = join(root, childName(name));
    const path = join(skill, "SKILL.md");
    const parsed = validate(text, path);
    for (const dir of [join(base, ".agents"), root]) {
      await checked(base, dir, true);
      try {
        await mkdir(dir);
      } catch (error) {
        if (codeOf(error) !== "EEXIST") throw error;
      }
      await checked(base, dir);
    }
    await mkdir(skill); // exclusive; never adopt an existing directory
    try {
      await checked(base, skill);
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      // Only remove our empty directory; do not recursively clean concurrent contents.
      try {
        await rmdir(skill);
      } catch {
        /* nonempty or changed: leave it for inspection */
      }
      throw error;
    }
    return {
      path,
      version: (await bytes(path, LIMIT.textBytes)).version,
      diagnostics: parsed.diagnostics,
    };
  }
  async #save(base: string, skill: string, text: string, version: string) {
    const path = join(skill, "SKILL.md");
    const parsed = validate(text, path);
    await access(path, constants.W_OK);
    await access(skill, constants.W_OK);
    await checked(base, path);
    if ((await bytes(path, LIMIT.textBytes)).version !== version)
      fail("conflict", path);
    const temp = join(skill, `.eta-skill-${randomUUID()}`);
    const mode = (await lstat(path)).mode & 0o777;
    const handle = await open(temp, "wx", mode);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
      await handle.close();
      await checked(base, path);
      if ((await bytes(path, LIMIT.textBytes)).version !== version)
        fail("conflict", path);
      await rename(temp, path);
    } finally {
      await handle.close();
      await unlink(temp).catch((error) => {
        if (codeOf(error) !== "ENOENT") throw error;
      });
    }
    return {
      path,
      version: (await bytes(path, LIMIT.textBytes)).version,
      diagnostics: parsed.diagnostics,
    };
  }
  async #plan(
    base: string,
    root: string,
    skill: string,
    shared: boolean,
  ): Promise<SkillDeletePlan> {
    // Require a regular SKILL.md so arbitrary container directories cannot be deleted.
    await checked(base, join(skill, "SKILL.md"));
    if (!(await lstat(join(skill, "SKILL.md"))).isFile())
      fail("not_skill", skill);
    const entries: SkillFileEntry[] = [];
    const hash = createHash("sha256");
    const versions: string[] = [];
    hash.update(
      skill +
        JSON.stringify(identity(await lstat(root))) +
        JSON.stringify(identity(await lstat(skill))),
    );
    const deadline = Date.now() + 25_000;
    const walk = async (dir: string, depth: number): Promise<void> => {
      for await (const entry of await opendir(dir)) {
        if (entries.length >= LIMIT.entries || depth > LIMIT.depth)
          fail("delete_budget", skill);
        const path = join(dir, entry.name);
        await checked(base, path);
        const info = await lstat(path);
        if (!info.isDirectory() && !info.isFile())
          fail("link_or_special_file", path);
        const item: SkillFileEntry = {
          path: relative(skill, path),
          kind: info.isDirectory() ? "directory" : "file",
          size: info.size,
        };
        entries.push(item);
        let contentVersion = "";
        if (info.isDirectory()) await walk(path, depth + 1);
        else {
          const handle = await open(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          try {
            const before = await handle.stat();
            if (!before.isFile()) fail("not_regular_file", path);
            const contentHash = createHash("sha256");
            const buffer = Buffer.alloc(64 * 1024);
            let offset = 0;
            while (offset < before.size) {
              if (Date.now() > deadline)
                fail("delete_verification_timeout", skill);
              const { bytesRead } = await handle.read(
                buffer,
                0,
                Math.min(buffer.length, before.size - offset),
                offset,
              );
              if (!bytesRead) fail("changed", path);
              offset += bytesRead;
              contentHash.update(buffer.subarray(0, bytesRead));
            }
            contentVersion = contentHash.digest("hex");
            if (
              JSON.stringify(stamp(before)) !==
              JSON.stringify(stamp(await handle.stat()))
            )
              fail("changed", path);
          } finally {
            await handle.close();
          }
        }
        versions.push(JSON.stringify([item.path, stamp(info), contentVersion]));
      }
    };
    await walk(skill, 1);
    for (const version of versions.sort()) hash.update(version);
    return {
      root,
      path: skill,
      name: basename(skill),
      shared,
      irreversible: true,
      entries,
      count: entries.length,
      version: hash.digest("hex"),
    };
  }
}
