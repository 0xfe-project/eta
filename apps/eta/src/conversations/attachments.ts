/**
 * Files a person attaches to a message, or to a task's comment.
 *
 * An attachment is uploaded before the message exists, in chunks over the same wire the browser
 * already has (so it passes through the same access gate and needs no second route), and waits as
 * a file under the data directory, per owner: `attachments/<conversation>/<id>-<name>` for a
 * conversation's, `attachments/task-<task>/<id>-<name>` for a task's. The row in `attachment` says
 * whose it is and whether a message (or comment) has claimed it. Sending claims the files; an agent
 * is handed each as a file it can open (`deliver`): a path on this machine for a session here, a
 * copy written on the daemon's machine through the link for a session there.
 */
import type { AttachmentView } from "@eta/client-contracts";
import type { ImageLimits } from "@eta/harness";
import type { SshTransport } from "@eta/ssh";
import type { Database } from "bun:sqlite";
import { Buffer } from "node:buffer";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  ATTACH_CHUNK_BYTES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
} from "@eta/client-contracts";
import { DEFAULT_IMAGE_LIMITS } from "@eta/harness";
import { shellQuote } from "@eta/ssh";
import { fitImage } from "../images/fit";

interface Row {
  id: string;
  conversation_id: string | null;
  /** Absent on a database from before task attachments (a test's own table). */
  task_id?: string | null;
  name: string;
  content_type: string;
  size: number;
  message_id: string | null;
  created_at: number;
}

export interface AttachmentRecord extends AttachmentView {
  /** The conversation it was attached in; null for a task's. */
  conversationId: string | null;
  /** The task whose comment it came with; null (or absent) for a conversation's. */
  taskId?: string | null;
  messageId: string | null;
}

/** Whose an attachment is: a conversation's (a message's) or a task's (a comment's). */
export type AttachmentOwner = { conversationId: string } | { taskId: string };

const ownerKey = (owner: AttachmentOwner): string =>
  "taskId" in owner ? `task-${owner.taskId}` : owner.conversationId;

/** The directory an attachment's file is in, under `attachments/` (and `~/.eta/uploads/`). */
const folderOf = (record: AttachmentRecord): string =>
  record.taskId == null
    ? (record.conversationId ?? "")
    : ownerKey({ taskId: record.taskId });

const owns = (owner: AttachmentOwner, record: AttachmentRecord): boolean =>
  "taskId" in owner
    ? record.taskId === owner.taskId
    : record.taskId == null && record.conversationId === owner.conversationId;

const recordOf = (row: Row): AttachmentRecord => ({
  id: row.id,
  conversationId: row.conversation_id,
  taskId: row.task_id ?? null,
  name: row.name,
  contentType: row.content_type,
  size: row.size,
  messageId: row.message_id,
});

export const viewOf = (record: AttachmentRecord): AttachmentView => ({
  id: record.id,
  name: record.name,
  contentType: record.contentType,
  size: record.size,
});

/** Strip what a path cannot hold, and keep the name recognisable. */
function safeName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = [...base]
    .map((character) =>
      character.codePointAt(0)! < 0x20 || '<>:"|?*'.includes(character)
        ? "_"
        : character,
    )
    .join("")
    .trim()
    .replace(/^\.+/, "");
  return cleaned === "" ? "file" : cleaned.slice(0, 120);
}

/** An upload id becomes part of a path, so it is a uuid and nothing else. */
const UPLOAD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An upload nobody sent is forgotten after this long. */
const UNSENT_TTL_MS = 24 * 60 * 60 * 1000;
/** The images a run carries are the first this many, each fitted for the model's limits. */
const MAX_IMAGES = 4;
/** The largest picture the transcript fetches; one reply carries it whole. */
const MAX_PICTURE_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
/** What one write over the link carries of a file. */
const DELIVER_CHUNK_BYTES = 3 * 1024 * 1024;

interface Upload {
  /** `ownerKey` of whose it is. */
  owner: string;
  name: string;
  contentType: string;
  /** The next chunk expected. */
  next: number;
  bytes: number;
}

export class AttachmentStore {
  readonly #db: Database;
  readonly #root: string;
  readonly #uploads = new Map<string, Upload>();

  constructor(db: Database, dataDir: string) {
    this.#db = db;
    this.#root = join(dataDir, "attachments");
    mkdirSync(this.#root, { recursive: true });
    this.#sweep();
  }

  /** Uploads a dead process left half-written, and files nobody ever sent. */
  #sweep(): void {
    for (const directory of readdirSync(this.#root, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue;
      for (const file of readdirSync(join(this.#root, directory.name))) {
        if (file.startsWith(".up-"))
          rmSync(join(this.#root, directory.name, file), { force: true });
      }
    }
    const stale = this.#db
      .query<Row, [number]>(
        "SELECT * FROM attachment WHERE message_id IS NULL AND created_at < ?",
      )
      .all(Date.now() - UNSENT_TTL_MS);
    for (const row of stale) {
      rmSync(this.pathOf(recordOf(row)), { force: true });
      this.#db.query("DELETE FROM attachment WHERE id = ?").run(row.id);
    }
  }

  pathOf(record: AttachmentRecord): string {
    return join(this.#root, folderOf(record), `${record.id}-${record.name}`);
  }

  get(id: string): AttachmentRecord | undefined {
    const row = this.#db
      .query<Row, [string]>("SELECT * FROM attachment WHERE id = ?")
      .get(id);
    return row === null ? undefined : recordOf(row);
  }

  /**
   * One chunk of an upload. Chunks arrive in order from 0 (the first one starts the upload over,
   * which is how a retry begins); the file lands, with its row, when the last one has.
   */
  async receive(input: {
    owner: AttachmentOwner;
    uploadId: string;
    name: string;
    contentType: string;
    index: number;
    last: boolean;
    data: string;
  }): Promise<AttachmentView | null> {
    if (!UPLOAD_ID.test(input.uploadId))
      throw new Error("uploadId must be a uuid");
    const existing = this.get(input.uploadId);
    if (existing !== undefined) {
      // The same upload again: its last chunk was resent after the reply was lost.
      if (!owns(input.owner, existing))
        throw new Error(`uploadId ${input.uploadId} is taken`);
      return viewOf(existing);
    }
    const chunk = Buffer.from(input.data, "base64");
    if (chunk.byteLength > ATTACH_CHUNK_BYTES)
      throw new Error(`a chunk is at most ${ATTACH_CHUNK_BYTES} bytes`);
    const owner = ownerKey(input.owner);
    const directory = join(this.#root, owner);
    const partial = join(directory, `.up-${input.uploadId}`);
    let upload = this.#uploads.get(input.uploadId);
    if (input.index === 0) {
      await mkdir(directory, { recursive: true });
      await writeFile(partial, chunk);
      upload = {
        owner,
        name: safeName(input.name),
        contentType: input.contentType,
        next: 1,
        bytes: chunk.byteLength,
      };
      this.#uploads.set(input.uploadId, upload);
    } else {
      if (
        upload === undefined ||
        upload.owner !== owner ||
        upload.next !== input.index
      )
        throw new Error(
          `chunk ${input.index} is out of order; start the upload again`,
        );
      upload.bytes += chunk.byteLength;
      if (upload.bytes <= MAX_ATTACHMENT_BYTES)
        await appendFile(partial, chunk);
      upload.next += 1;
    }
    if (upload!.bytes > MAX_ATTACHMENT_BYTES) {
      this.#uploads.delete(input.uploadId);
      await rm(partial, { force: true });
      throw new Error(
        `a file is at most ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB`,
      );
    }
    if (!input.last) return null;
    this.#uploads.delete(input.uploadId);
    if (upload!.bytes === 0) {
      await rm(partial, { force: true });
      throw new Error("the file is empty");
    }
    const record: AttachmentRecord = {
      id: input.uploadId,
      conversationId:
        "conversationId" in input.owner ? input.owner.conversationId : null,
      taskId: "taskId" in input.owner ? input.owner.taskId : null,
      name: upload!.name,
      contentType: upload!.contentType,
      size: upload!.bytes,
      messageId: null,
    };
    await rename(partial, this.pathOf(record));
    this.#db
      .query(
        record.taskId == null
          ? `INSERT INTO attachment (id, conversation_id, name, content_type, size, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          : `INSERT INTO attachment (id, task_id, name, content_type, size, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.taskId ?? record.conversationId,
        record.name,
        record.contentType,
        record.size,
        Date.now(),
      );
    return viewOf(record);
  }

  /** A deleted task's files: its rows went with it, and the files go now. */
  async dropTask(taskId: string): Promise<void> {
    await rm(join(this.#root, ownerKey({ taskId })), {
      recursive: true,
      force: true,
    });
  }

  /** Take back a file that was never sent. */
  async remove(owner: AttachmentOwner, id: string): Promise<boolean> {
    const record = this.get(id);
    if (
      record === undefined ||
      !owns(owner, record) ||
      record.messageId !== null
    )
      return false;
    this.#db.query("DELETE FROM attachment WHERE id = ?").run(id);
    await rm(this.pathOf(record), { force: true });
    return true;
  }

  /**
   * A sent image of this conversation (or task), to be shown in its transcript (or timeline). Any
   * image type a browser draws (the Windows client pastes bmp), not only those a model takes;
   * unsent files, other owners' files and other kinds of file are refused.
   */
  async picture(
    owner: AttachmentOwner,
    id: string,
  ): Promise<{ contentType: string; data: string }> {
    const record = this.get(id);
    if (
      record === undefined ||
      !owns(owner, record) ||
      record.messageId === null
    )
      throw new Error(`no such attachment: ${id}`);
    if (!record.contentType.startsWith("image/"))
      throw new Error(`${record.name} is not an image`);
    if (record.size > MAX_PICTURE_BYTES)
      throw new Error(
        `${record.name} is over the ${MAX_PICTURE_BYTES / (1024 * 1024)} MB a picture may be`,
      );
    const bytes = await readFile(this.pathOf(record));
    return { contentType: record.contentType, data: bytes.toString("base64") };
  }

  /**
   * The files a message (or comment) is about to carry, checked: they exist, are this owner's, have
   * not gone with another message, and are not too many. Call inside the transaction that writes
   * the message, then `claim` in it.
   */
  check(owner: AttachmentOwner, ids: readonly string[]): AttachmentRecord[] {
    if (ids.length > MAX_ATTACHMENTS)
      throw new Error(`a message carries at most ${MAX_ATTACHMENTS} files`);
    return [...new Set(ids)].map((id) => {
      const record = this.get(id);
      if (record === undefined || !owns(owner, record))
        throw new Error(`no such attachment: ${id}`);
      if (record.messageId !== null)
        throw new Error(`attachment ${id} was already sent`);
      return record;
    });
  }

  claim(ids: readonly string[], messageId: string): void {
    for (const id of ids)
      this.#db
        .query("UPDATE attachment SET message_id = ? WHERE id = ?")
        .run(messageId, id);
  }

  /** The files a row carries, as its `data.attachments` lists them. */
  carried(data: Record<string, unknown>): AttachmentRecord[] {
    const listed = data.attachments;
    if (!Array.isArray(listed)) return [];
    return listed.flatMap((entry: { id?: unknown }) => {
      const record =
        typeof entry?.id === "string" ? this.get(entry.id) : undefined;
      return record === undefined ? [] : [record];
    });
  }

  /**
   * The images among `records` a model can be given in the prompt: the common formats, up to
   * `MAX_IMAGES`, each scaled down if needed to fit `limits`. Any image attachment that cannot be
   * shown (unsupported format, over the per-turn count limit, unreadable, or unfittable) is
   * recorded in `omitted` with its reason so the caller can tell the model instead of silently
   * dropping it.
   */
  async images(
    records: readonly AttachmentRecord[],
    limits: ImageLimits = DEFAULT_IMAGE_LIMITS,
  ): Promise<{
    images: { mime: string; dataBase64: string }[];
    omitted: Map<string, string>;
  }> {
    const images: { mime: string; dataBase64: string }[] = [];
    const omitted = new Map<string, string>();
    for (const record of records) {
      if (!record.contentType.startsWith("image/")) continue;
      if (!limits.mimeTypes.includes(record.contentType)) {
        omitted.set(
          record.id,
          `${record.contentType} is not a format the model takes (${limits.mimeTypes.join(", ")})`,
        );
        continue;
      }
      if (images.length >= MAX_IMAGES) {
        omitted.set(
          record.id,
          `at most ${MAX_IMAGES} images are shown per turn; use read_image to view it`,
        );
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = await readFile(this.pathOf(record));
      } catch (error) {
        omitted.set(
          record.id,
          error instanceof Error ? error.message : String(error),
        );
        continue;
      }
      try {
        const fitted = await fitImage(
          record.name,
          record.contentType,
          bytes,
          limits.maxBytes,
          { maxSide: limits.maxSide },
        );
        images.push({
          mime: fitted.mime,
          dataBase64: fitted.bytes.toString("base64"),
        });
      } catch (error) {
        omitted.set(
          record.id,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return { images, omitted };
  }

  /**
   * One image as a model can be given it, scaled down when it is over `limits`; throws why it
   * cannot be, for a tool to say. The stored file stays as it was uploaded.
   */
  async image(
    record: AttachmentRecord,
    limits: ImageLimits = DEFAULT_IMAGE_LIMITS,
  ): Promise<{ mime: string; dataBase64: string }> {
    if (!limits.mimeTypes.includes(record.contentType))
      throw new Error(
        `${record.name} is ${record.contentType}, not an image a model takes (${limits.mimeTypes.join(", ")})`,
      );
    const bytes = await readFile(this.pathOf(record));
    const fitted = await fitImage(
      record.name,
      record.contentType,
      bytes,
      limits.maxBytes,
      { maxSide: limits.maxSide },
    );
    return { mime: fitted.mime, dataBase64: fitted.bytes.toString("base64") };
  }

  /**
   * Make each file reachable by an agent whose session is on `transport`'s machine, and say where:
   * for this machine the stored file itself, for a daemon a copy under its home
   * (`~/.eta/uploads/<conversation>/`, `~/.eta/uploads/task-<task>/`), written through the link in pieces and skipped when a
   * file of the same size is already there. A file that could not be delivered is left out of the
   * answer and the reason is returned beside it.
   */
  async deliver(
    records: readonly AttachmentRecord[],
    transport: SshTransport | undefined,
  ): Promise<{ paths: Map<string, string>; failed: Map<string, string> }> {
    const paths = new Map<string, string>();
    const failed = new Map<string, string>();
    for (const record of records) {
      try {
        paths.set(record.id, await this.#place(record, transport));
      } catch (error) {
        failed.set(
          record.id,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return { paths, failed };
  }

  async #place(
    record: AttachmentRecord,
    transport: SshTransport | undefined,
  ): Promise<string> {
    const local = this.pathOf(record);
    if (transport === undefined) {
      await stat(local);
      return local;
    }
    const file = `"$HOME"/.eta/uploads/${shellQuote(folderOf(record))}/${shellQuote(`${record.id}-${record.name}`)}`;
    const present = await transport.run(
      `f=${file}; if [ -f "$f" ] && [ "$(wc -c < "$f")" -eq ${record.size} ]; then printf '%s' "$f"; else printf ''; fi`,
    );
    if (present.code === 0 && present.stdout !== "") return present.stdout;
    const bytes = await readFile(local);
    let path = "";
    for (let at = 0; at < bytes.byteLength; at += DELIVER_CHUNK_BYTES) {
      const written = await transport.run(
        `f=${file}; ${at === 0 ? 'mkdir -p "$(dirname "$f")" && cat > "$f"' : 'cat >> "$f"'} && printf '%s' "$f"`,
        {
          input: bytes.subarray(at, at + DELIVER_CHUNK_BYTES),
          timeoutMs: 60_000,
        },
      );
      if (written.code !== 0)
        throw new Error(
          written.stderr.trim() ||
            `could not write the file (exit ${written.code})`,
        );
      path = written.stdout;
    }
    return path;
  }
}

/**
 * `GET /attachments/<id>`: an attached file's bytes, behind the normal access. A picture in the
 * image formats a browser draws comes as itself, for the page that shows it; any other file (an
 * SVG, a page, a PDF) comes as opaque bytes to save (`application/octet-stream`, `attachment`),
 * never as something a browser would show, since served from this origin it could run as the
 * app. It never changes, so it is kept.
 */
export function createAttachmentRoutes(
  attachments: AttachmentStore,
): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    const parts = new URL(request.url).pathname.split("/");
    if (parts[1] !== "attachments" || parts.length !== 3) return undefined;
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("method not allowed", {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
    const id = parts[2] ?? "";
    const record = UPLOAD_ID.test(id) ? attachments.get(id) : undefined;
    const bytes =
      record === undefined
        ? undefined
        : await readFile(attachments.pathOf(record)).catch(() => undefined);
    if (record === undefined || bytes === undefined)
      return new Response("not found", {
        status: 404,
        headers: { "cache-control": "no-store" },
      });
    const picture = IMAGE_TYPES.has(record.contentType);
    return new Response(request.method === "HEAD" ? null : bytes, {
      headers: {
        "content-type": picture
          ? record.contentType
          : "application/octet-stream",
        ...(picture
          ? {}
          : {
              "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(record.name)}`,
            }),
        "content-length": String(bytes.byteLength),
        "cache-control": "private, max-age=31536000, immutable",
        "content-security-policy": "sandbox",
        "x-content-type-options": "nosniff",
      },
    });
  };
}
