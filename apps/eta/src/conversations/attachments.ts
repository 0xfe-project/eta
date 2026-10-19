/**
 * Files a person attaches to a message.
 *
 * An attachment is uploaded before the message exists, in chunks over the same wire the browser
 * already has (so it passes through the same access gate and needs no second route), and waits as
 * a file under the data directory, per conversation: `attachments/<conversation>/<id>-<name>`.
 * The row in `attachment` says whose it is and whether a message has claimed it. Sending claims
 * the files; an agent is handed each as a file it can open (`deliver`): a path on this machine for
 * a session here, a copy written on the daemon's machine through the link for a session there.
 */
import type { AttachmentView } from "@eta/client-contracts";
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
import { shellQuote } from "@eta/ssh";

interface Row {
  id: string;
  conversation_id: string;
  name: string;
  content_type: string;
  size: number;
  message_id: string | null;
  created_at: number;
}

export interface AttachmentRecord extends AttachmentView {
  conversationId: string;
  messageId: string | null;
}

const recordOf = (row: Row): AttachmentRecord => ({
  id: row.id,
  conversationId: row.conversation_id,
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
/** The images a run carries are the first this many, up to this many bytes in all. */
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
/** What one write over the link carries of a file. */
const DELIVER_CHUNK_BYTES = 3 * 1024 * 1024;

interface Upload {
  conversationId: string;
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
    return join(
      this.#root,
      record.conversationId,
      `${record.id}-${record.name}`,
    );
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
    conversationId: string;
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
      if (existing.conversationId !== input.conversationId)
        throw new Error(`uploadId ${input.uploadId} is taken`);
      return viewOf(existing);
    }
    const chunk = Buffer.from(input.data, "base64");
    if (chunk.byteLength > ATTACH_CHUNK_BYTES)
      throw new Error(`a chunk is at most ${ATTACH_CHUNK_BYTES} bytes`);
    const directory = join(this.#root, input.conversationId);
    const partial = join(directory, `.up-${input.uploadId}`);
    let upload = this.#uploads.get(input.uploadId);
    if (input.index === 0) {
      await mkdir(directory, { recursive: true });
      await writeFile(partial, chunk);
      upload = {
        conversationId: input.conversationId,
        name: safeName(input.name),
        contentType: input.contentType,
        next: 1,
        bytes: chunk.byteLength,
      };
      this.#uploads.set(input.uploadId, upload);
    } else {
      if (
        upload === undefined ||
        upload.conversationId !== input.conversationId ||
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
      conversationId: input.conversationId,
      name: upload!.name,
      contentType: upload!.contentType,
      size: upload!.bytes,
      messageId: null,
    };
    await rename(partial, this.pathOf(record));
    this.#db
      .query(
        `INSERT INTO attachment (id, conversation_id, name, content_type, size, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.conversationId,
        record.name,
        record.contentType,
        record.size,
        Date.now(),
      );
    return viewOf(record);
  }

  /** Take back a file that was never sent. */
  async remove(conversationId: string, id: string): Promise<boolean> {
    const record = this.get(id);
    if (
      record === undefined ||
      record.conversationId !== conversationId ||
      record.messageId !== null
    )
      return false;
    this.#db.query("DELETE FROM attachment WHERE id = ?").run(id);
    await rm(this.pathOf(record), { force: true });
    return true;
  }

  /**
   * The files a message is about to carry, checked: they exist, are this conversation's, have not
   * gone with another message, and are not too many. Call inside the transaction that writes the
   * message, then `claim` in it.
   */
  check(conversationId: string, ids: readonly string[]): AttachmentRecord[] {
    if (ids.length > MAX_ATTACHMENTS)
      throw new Error(`a message carries at most ${MAX_ATTACHMENTS} files`);
    return [...new Set(ids)].map((id) => {
      const record = this.get(id);
      if (record === undefined || record.conversationId !== conversationId)
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
   * The images among `records` a model can be given in the prompt: the common formats, few and
   * small enough to travel (over the link they share one frame).
   */
  async images(
    records: readonly AttachmentRecord[],
  ): Promise<{ mime: string; dataBase64: string }[]> {
    const images: { mime: string; dataBase64: string }[] = [];
    let total = 0;
    for (const record of records) {
      if (images.length >= MAX_IMAGES) break;
      if (!IMAGE_TYPES.has(record.contentType)) continue;
      if (total + record.size > MAX_IMAGE_BYTES) continue;
      const bytes = await readFile(this.pathOf(record)).catch(() => undefined);
      if (bytes === undefined) continue;
      total += bytes.byteLength;
      images.push({
        mime: record.contentType,
        dataBase64: bytes.toString("base64"),
      });
    }
    return images;
  }

  /**
   * Make each file reachable by an agent whose session is on `transport`'s machine, and say where:
   * for this machine the stored file itself, for a daemon a copy under its home
   * (`~/.eta/uploads/<conversation>/`), written through the link in pieces and skipped when a
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
    const file = `"$HOME"/.eta/uploads/${shellQuote(record.conversationId)}/${shellQuote(`${record.id}-${record.name}`)}`;
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
