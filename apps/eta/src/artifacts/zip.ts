/**
 * The ZIP reader, writer and site check (REFACTOR.md §9, P3.2).
 *
 * An artifact is a static site in a ZIP, and the rules about what a valid one is are the product's
 * (AXP's, ported here): an `index.html` at the root, every path a clean relative path under it, no
 * links, nothing encrypted, nothing compressed beyond stored and deflated, and within limits. A
 * package that fails any of them is refused whole — nothing is stored, and the message says what to
 * fix.
 *
 * Written by hand because neither the runtime nor the tree has a ZIP: Bun gives deflate, inflate
 * and crc32, and the rest is the format. That is a small, well-specified amount of code — the
 * central directory at the end of the file names every entry, and an entry's bytes are either
 * stored as they are or deflated.
 */
/** What an upload may hold; the same numbers AXP used, because they are the gateway's. */
export interface ZipLimits {
  /** The ZIP itself, in bytes. */
  archive: number;
  /** Files in it (directories do not count). */
  files: number;
  /** Their total size once extracted. */
  bytes: number;
}

export const DEFAULT_LIMITS: ZipLimits = {
  archive: 90 << 20,
  files: 5000,
  bytes: 512 << 20,
};

/** A package that is not a site. The route answers 422 `INVALID_ARTIFACT` with this message. */
export class InvalidArtifact extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidArtifact";
  }
}

export interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflated; anything else is refused before an entry is read. */
  method: number;
  flags: number;
  /** The POSIX mode, when the entry declares one (a symlink is 0o120000 here). */
  mode: number;
  compressedSize: number;
  uncompressedSize: number;
  /** The entry's bytes, decompressed. */
  data: () => Uint8Array;
}

/**
 * Bun's byte APIs want an `ArrayBuffer`-backed view; a subarray of one still is one, but the type
 * says `ArrayBufferLike` (which also covers `SharedArrayBuffer`), so it is narrowed here once.
 */
const asBytes = (value: Uint8Array): Uint8Array<ArrayBuffer> =>
  value as Uint8Array<ArrayBuffer>;

const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** The end-of-central-directory record, which is how a ZIP is found: from its tail. */
function endOfCentralDirectory(bytes: Uint8Array): number {
  const dv = view(bytes);
  const earliest = Math.max(0, bytes.length - 65_557);
  for (let at = bytes.length - 22; at >= earliest; at--) {
    if (dv.getUint32(at, true) === 0x0605_4b50) return at;
  }
  throw new InvalidArtifact("这不是一个 ZIP 文件。");
}

/**
 * Every entry in a ZIP, in central-directory order.
 *
 * Nothing is decompressed here: the directory says what an entry is (name, method, sizes, mode),
 * which is what the site check reads. Bytes are read only for the entries that pass.
 */
export function readZip(bytes: Uint8Array): ZipEntry[] {
  const dv = view(bytes);
  const eocd = endOfCentralDirectory(bytes);
  const count = dv.getUint16(eocd + 10, true);
  const directoryAt = dv.getUint32(eocd + 16, true);
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const entries: ZipEntry[] = [];
  let at = directoryAt;
  for (let index = 0; index < count; index++) {
    if (dv.getUint32(at, true) !== 0x0201_4b50) {
      throw new InvalidArtifact("ZIP 的目录损坏了。");
    }
    const flags = dv.getUint16(at + 8, true);
    const method = dv.getUint16(at + 10, true);
    const compressedSize = dv.getUint32(at + 20, true);
    const uncompressedSize = dv.getUint32(at + 24, true);
    const nameLength = dv.getUint16(at + 28, true);
    const extraLength = dv.getUint16(at + 30, true);
    const commentLength = dv.getUint16(at + 32, true);
    const externalAttributes = dv.getUint32(at + 38, true);
    const localAt = dv.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    // The high 16 bits of the external attributes are the POSIX mode (unix); 0 when the ZIP was
    // written on something without one, which is why a plain file is 0 and not 0o100644.
    const mode = externalAttributes >>> 16;
    entries.push({
      name,
      method,
      flags,
      mode,
      compressedSize,
      uncompressedSize,
      data: () =>
        entryData(bytes, localAt, method, compressedSize, uncompressedSize),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** One entry's bytes: skip its local header, then inflate if it was deflated. */
function entryData(
  bytes: Uint8Array,
  localAt: number,
  method: number,
  compressedSize: number,
  uncompressedSize: number,
): Uint8Array {
  const dv = view(bytes);
  if (dv.getUint32(localAt, true) !== 0x0403_4b50) {
    throw new InvalidArtifact("ZIP 里的条目损坏了。");
  }
  const nameLength = dv.getUint16(localAt + 26, true);
  const extraLength = dv.getUint16(localAt + 28, true);
  const from = localAt + 30 + nameLength + extraLength;
  const raw = bytes.subarray(from, from + compressedSize);
  if (method === 0) return raw;
  const inflated = Bun.inflateSync(asBytes(raw));
  if (inflated.byteLength !== uncompressedSize) {
    throw new InvalidArtifact("ZIP 里条目的实际大小与声明不符。");
  }
  return inflated;
}

/** Whether a mode says symlink (or anything that is not a regular file). */
const isSymlink = (mode: number): boolean => (mode & 0o170000) === 0o120000;
const isRegular = (mode: number): boolean =>
  mode === 0 || (mode & 0o170000) === 0o100000;

/** A clean relative path under the site's root, the same on every system. */
function checkPath(name: string): void {
  const reject = (): never => {
    throw new InvalidArtifact(
      `路径必须是根目录下的相对路径：${JSON.stringify(name)}`,
    );
  };
  if (name.length === 0 || name.length > 1024) {
    throw new InvalidArtifact(`ZIP 里有无效的路径：${JSON.stringify(name)}`);
  }
  if (/[\\\0:]/.test(name)) {
    throw new InvalidArtifact(
      `路径里不能有反斜杠、冒号或空字符：${JSON.stringify(name)}`,
    );
  }
  if (name.startsWith("/")) reject();
  for (const part of name.split("/")) {
    if (part === ".." || part === "." || part.length > 255) reject();
    if (part.length === 0) reject();
  }
}

export interface SiteFile {
  name: string;
  bytes: Uint8Array;
}

/**
 * Check a ZIP is a static site and read its files.
 *
 * The whole package is judged before a single byte is stored: an artifact that is half written is
 * worse than one that was refused, because the half that is there looks like a working site.
 */
export function readSite(
  bytes: Uint8Array,
  limits: ZipLimits = DEFAULT_LIMITS,
): SiteFile[] {
  const entries = readZip(bytes);
  const files: SiteFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const entry of entries) {
    if (
      entry.name.endsWith("/") ||
      (entry.mode !== 0 && (entry.mode & 0o170000) === 0o040000)
    ) {
      continue; // a directory: nothing is stored for it
    }
    if (isSymlink(entry.mode)) {
      throw new InvalidArtifact(`ZIP 里不能有符号链接：${entry.name}`);
    }
    if (!isRegular(entry.mode)) {
      throw new InvalidArtifact(`ZIP 里只能有普通文件：${entry.name}`);
    }
    const name = entry.name.startsWith("./") ? entry.name.slice(2) : entry.name;
    checkPath(name);
    if (seen.has(name)) {
      throw new InvalidArtifact(`ZIP 里有重复的文件：${name}`);
    }
    seen.add(name);
    if ((entry.flags & 0x1) !== 0) {
      throw new InvalidArtifact(`ZIP 里不能有加密的文件：${name}`);
    }
    if (entry.method !== 0 && entry.method !== 8) {
      throw new InvalidArtifact(
        `不支持 ${name} 的压缩方式（只支持 stored 和 deflate）`,
      );
    }
    if (files.length === limits.files) {
      throw new InvalidArtifact(`文件超过 ${limits.files} 个`);
    }
    total += entry.uncompressedSize;
    if (total > limits.bytes) {
      throw new InvalidArtifact(`解压后超过 ${limits.bytes >> 20} MiB`);
    }
    files.push({ name, bytes: entry.data() });
  }
  if (!seen.has("index.html")) {
    // The common mistake is zipping the folder instead of its contents; say how to fix it.
    for (const name of seen) {
      const parts = name.split("/");
      if (parts.length === 2 && parts[1] === "index.html") {
        throw new InvalidArtifact(
          `index.html 必须在 ZIP 的根目录，现在在 ${parts[0]}/ 里：在这个目录里面打包（cd ${parts[0]} && zip -r ../site.zip .）`,
        );
      }
    }
    throw new InvalidArtifact("ZIP 的根目录没有 index.html");
  }
  return files;
}

/** The content type of a file in a site, by extension. */
export function contentTypeOf(name: string): string {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  switch (extension) {
    case "html":
    case "htm":
      return "text/html; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "js":
    case "mjs":
      return "text/javascript; charset=utf-8";
    case "json":
      return "application/json; charset=utf-8";
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "avif":
      return "image/avif";
    case "ico":
      return "image/x-icon";
    case "woff":
      return "font/woff";
    case "woff2":
      return "font/woff2";
    case "ttf":
      return "font/ttf";
    case "otf":
      return "font/otf";
    case "txt":
    case "md":
      return "text/plain; charset=utf-8";
    case "wasm":
      return "application/wasm";
    case "pdf":
      return "application/pdf";
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mp3":
      return "audio/mpeg";
    default:
      return "application/octet-stream";
  }
}

/**
 * Pack files into a ZIP.
 *
 * Entries are deflated when that makes them smaller and stored when it does not, which is what
 * every other tool does; the archive is what the limits are checked against, so compressing text
 * is the difference between an upload that fits and one that does not.
 */
export function writeZip(files: readonly SiteFile[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = new TextEncoder().encode(file.name);
    const crc = Bun.hash.crc32(asBytes(file.bytes));
    const deflated =
      file.bytes.byteLength > 64
        ? Bun.deflateSync(asBytes(file.bytes))
        : undefined;
    const useDeflate =
      deflated !== undefined && deflated.byteLength < file.bytes.byteLength;
    const body = useDeflate ? deflated : file.bytes;
    const method = useDeflate ? 8 : 0;

    const local = new Uint8Array(30 + name.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x0403_4b50, true);
    localView.setUint16(4, 20, true); // version needed
    localView.setUint16(6, 0, true); // flags
    localView.setUint16(8, method, true);
    localView.setUint16(10, 0, true); // time
    localView.setUint16(12, 0, true); // date
    localView.setUint32(14, crc >>> 0, true);
    localView.setUint32(18, body.byteLength, true);
    localView.setUint32(22, file.bytes.byteLength, true);
    localView.setUint16(26, name.byteLength, true);
    localView.setUint16(28, 0, true); // extra length
    local.set(name, 30);
    chunks.push(local, body);

    const entry = new Uint8Array(46 + name.byteLength);
    const entryView = new DataView(entry.buffer);
    entryView.setUint32(0, 0x0201_4b50, true);
    entryView.setUint16(4, 20, true); // version made by
    entryView.setUint16(6, 20, true); // version needed
    entryView.setUint16(8, 0, true); // flags
    entryView.setUint16(10, method, true);
    entryView.setUint16(12, 0, true);
    entryView.setUint16(14, 0, true);
    entryView.setUint32(16, crc >>> 0, true);
    entryView.setUint32(20, body.byteLength, true);
    entryView.setUint32(24, file.bytes.byteLength, true);
    entryView.setUint16(28, name.byteLength, true);
    entryView.setUint16(30, 0, true); // extra
    entryView.setUint16(32, 0, true); // comment
    entryView.setUint16(34, 0, true); // disk
    entryView.setUint16(36, 0, true); // internal attributes
    // Regular file, mode 0644, so an unzip on unix gives a sane permission.
    entryView.setUint32(38, (0o100644 << 16) >>> 0, true);
    entryView.setUint32(42, offset, true);
    entry.set(name, 46);
    central.push(entry);

    offset += local.byteLength + body.byteLength;
  }

  const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x0605_4b50, true);
  eocdView.setUint16(4, 0, true); // this disk
  eocdView.setUint16(6, 0, true); // disk with directory
  eocdView.setUint16(8, files.length, true);
  eocdView.setUint16(10, files.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);
  eocdView.setUint16(20, 0, true); // comment length

  const total = offset + centralSize + eocd.byteLength;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of [...chunks, ...central, eocd]) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
