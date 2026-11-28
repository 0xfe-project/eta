import type { WebViewDownload, WebViewRef } from "nsh";
import {
  exists,
  mkdir,
  readdir,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "fs/promises";
import { homedir } from "os";
import { cleanup, platform, Share, signal, WebView } from "nsh";
import { uiText } from "../../../i18n";

// NSH expands these placeholders when its file and share APIs access app storage and the home directory.
const exportsDirectory = `\${dataDir}/artifact-exports`;
const downloadDirectory = `\${dataDir}/downloads`;
const downloadsFolder = `\${homeDir}/Downloads`;
const directWriteLimit = 8 * 1024 * 1024;
const chunkSize = 128 * 1024;
const transferPage = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'"><script>
const parts = [];
addEventListener("message", event => {
  const {data, name, mime} = JSON.parse(event.data);
  if (data) {
    const chunk = atob(data);
    parts.push(Uint8Array.from(chunk, char => char.charCodeAt(0)));
    window.nsh.postMessage("next");
    return;
  }
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob(parts, {type:mime}));
  parts.length = 0;
  link.download = name;
  document.body.append(link);
  link.click();
});
</script><body></body>`;

type Extension = "pdf" | "zip";

function filename(title: string, version: number, extension: Extension) {
  const cleaned = Array.from(title.replace(/[\\/:*?"<>|\p{Cc}]/gu, "-").trim())
    .slice(0, 48)
    .join("");
  return `${cleaned.replace(/^\.+|[. ]+$/g, "") || "Artifact"}-v${version}.${extension}`;
}

async function removeExport(directory: string) {
  for (const name of await readdir(directory))
    await unlink(`${directory}/${name}`);
  await rmdir(directory);
}

async function expireShares() {
  // Android returns as soon as a receiving app is selected. Keep its URI valid
  // while that app reads the file, then retire old shares at the next export.
  for (const entry of await readdir(exportsDirectory, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory() || !entry.name.startsWith("share-")) continue;
    const directory = `${exportsDirectory}/${entry.name}`;
    if ((await stat(directory)).mtimeMs < Date.now() - 86400000)
      await removeExport(directory);
  }
}

/** The first of `name`, `name (1).ext`, `name (2).ext`, … that is free in the Downloads folder. */
async function freeDownloadName(name: string) {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  let candidate = name;
  for (let n = 1; await exists(`${downloadsFolder}/${candidate}`); n++)
    candidate = `${stem} (${n})${extension}`;
  return candidate;
}

/** Where a saved file went: its full path, its name there, and whether that is the Downloads folder. */
export interface SavedFile {
  path: string;
  name: string;
  downloads: boolean;
}

/** The completed download notification for a file saved into the Downloads folder. */
export function savedToDownloads(saved: SavedFile) {
  return {
    title: uiText("savedToDownloads", { name: saved.name }),
    detail: undefined,
    path: saved.path,
    showWhenQuick: true,
  };
}

interface Transfer {
  bytes: Uint8Array;
  name: string;
  mime: string;
  destination: string;
  resolve: () => void;
  reject: (cause: Error) => void;
  closed: boolean;
  finalizing?: Promise<void>;
}

async function finishDownload(job: Transfer, id: string) {
  const directory = `${downloadDirectory}/${id}`;
  const source = `${directory}/${job.name}`;
  try {
    if ((await stat(source)).size !== job.bytes.length)
      throw new Error("Incomplete download.");
    if (job.closed) {
      await unlink(source);
      return;
    }
    await rename(source, job.destination);
    job.resolve();
  } catch (error) {
    await unlink(source).catch(() => {});
    job.reject(error instanceof Error ? error : new Error(String(error)));
  } finally {
    await rmdir(directory).catch(() => {});
  }
}

// NSH's direct file writer accepts up to 8 MiB. Its WebView download writes
// larger files through the platform, from a Blob owned by this local page.
function FileTransfer(props: { job: Transfer }) {
  let page: WebViewRef | undefined;
  let closed = false;
  let started = false;
  let timeout: ReturnType<typeof setTimeout>;
  function deadline() {
    clearTimeout(timeout);
    timeout = setTimeout(
      () => props.job.reject(new Error("File download timed out.")),
      60000,
    );
  }
  deadline();
  cleanup(() => {
    closed = true;
    clearTimeout(timeout);
  });
  let offset = 0;
  function writeNext() {
    if (!page || closed || props.job.closed) return;
    deadline();
    const { bytes, name, mime } = props.job;
    if (offset === bytes.length) {
      page.postMessage(JSON.stringify({ name, mime }));
      return;
    }
    const chunk = bytes.subarray(offset, offset + chunkSize);
    offset += chunk.length;
    page.postMessage(
      JSON.stringify({ data: Buffer.from(chunk).toString("base64") }),
    );
  }
  function received(event: WebViewDownload) {
    const job = props.job;
    if (closed || job.closed || job.finalizing) return;
    if (event.state === "started") {
      deadline();
      return;
    }
    if (event.state !== "finished") {
      job.reject(new Error(event.message || "File download was interrupted."));
      return;
    }
    if (!/^[\w-]+$/.test(event.id) || event.filename !== job.name) {
      job.reject(new Error("Unexpected download filename."));
      return;
    }
    job.finalizing = finishDownload(job, event.id);
  }
  return (
    <WebView
      html={transferPage}
      baseUrl="https://eta-export.invalid/"
      incognito
      ref={(ref) => {
        page = ref;
      }}
      style={{
        position: "absolute",
        left: 0,
        bottom: 0,
        width: 1,
        height: 1,
        opacity: 0,
        pointerEvents: "none",
      }}
      onLoad={() => {
        if (!started) {
          started = true;
          writeNext();
        }
      }}
      onMessage={({ data }) => {
        if (data === "next") writeNext();
      }}
      onDownload={received}
      onError={(error) => props.job.reject(new Error(error.message))}
    />
  );
}

/**
 * Saves files the app holds: on a desktop into the Downloads folder, under a free name; elsewhere
 * through the share sheet where there is one, else into the app's storage. `save` resolves with
 * where the file went (`savedPath` holds its path too); files over NSH's direct write limit go
 * through a WebView download (`writer` mounts it). One file at a time.
 */
export function createFileSaver() {
  const transfer = signal<Transfer | undefined>(undefined);
  const savedPath = signal("");
  let active = false;
  let closed = false;
  cleanup(() => {
    closed = true;
    const job = transfer();
    if (job) {
      job.closed = true;
      job.reject(new Error("Export closed."));
    }
  });
  async function save(
    bytes: Uint8Array,
    name: string,
    mime: string,
    request?: AbortSignal,
  ): Promise<SavedFile | undefined> {
    if (closed || active)
      throw new Error("Another file export is in progress.");
    active = true;
    savedPath.set("");
    const id = crypto.randomUUID();
    let directory: string | undefined;
    // A file written into the Downloads folder, removed alone if the save does not finish.
    let download: string | undefined;
    let keep = false;
    let job: Transfer | undefined;
    const stopped = () => closed || request?.aborted;
    const cancel = () => {
      if (job) {
        job.closed = true;
        job.reject(new Error("Export cancelled."));
      }
    };
    request?.addEventListener("abort", cancel);
    const write = async (path: string) => {
      if (bytes.length <= directWriteLimit) await writeFile(path, bytes);
      else
        await new Promise<void>((resolve, reject) => {
          job = {
            bytes,
            name,
            mime,
            destination: path,
            closed: false,
            resolve,
            reject,
          };
          transfer.set(job);
        });
      transfer.set(undefined);
    };
    try {
      if (stopped()) return;
      if (
        platform.os === "macos" ||
        platform.os === "windows" ||
        platform.os === "linux"
      ) {
        const home = homedir();
        await mkdir(downloadsFolder, { recursive: true });
        const saved = await freeDownloadName(name);
        if (stopped()) return;
        download = `${downloadsFolder}/${saved}`;
        await write(download);
        if (stopped()) return;
        const separator = platform.os === "windows" ? "\\" : "/";
        const path = `${home}${separator}Downloads${separator}${saved}`;
        savedPath.set(path);
        keep = true;
        return { path, name: saved, downloads: true };
      }
      const sharing = await Share.available();
      if (stopped()) return;
      directory = `${exportsDirectory}/${sharing ? "share-" : ""}${id}`;
      const path = `${directory}/${name}`;
      await mkdir(directory, { recursive: true });
      if (platform.os === "android") await expireShares().catch(() => {});
      if (stopped()) return;
      await write(path);
      if (stopped()) return;
      if (sharing) {
        const result = await Share.show({ title: name, files: [path] });
        keep = platform.os === "android" && result.action === "shared";
      } else {
        // NSH exposes the storage directory on the VM global.
        // eslint-disable-next-line node/prefer-global/process
        const dataDir = globalThis.process?.dataDir;
        if (!dataDir)
          throw new Error("No local file destination is available.");
        const path = `${dataDir}/artifact-exports/${id}/${name}`;
        savedPath.set(path);
        keep = true;
        return { path, name, downloads: false };
      }
    } finally {
      request?.removeEventListener("abort", cancel);
      if (job) job.closed = true;
      transfer.set(undefined);
      // A native rename already in flight can still create the destination after an abort.
      await job?.finalizing;
      if (!keep && directory) await removeExport(directory).catch(() => {});
      if (!keep && download) await unlink(download).catch(() => {});
      active = false;
    }
  }
  const writer = () => (
    <If when={transfer()}>{(job) => <FileTransfer job={job()} />}</If>
  );
  return { save, writer, savedPath };
}

/** An artifact's export (PDF, ZIP) saved as `<title>-v<version>.<extension>`. */
export function createArtifactFileSaver() {
  const saver = createFileSaver();
  return {
    ...saver,
    save: (
      bytes: Uint8Array,
      title: string,
      version: number,
      extension: Extension,
      request?: AbortSignal,
    ) =>
      saver.save(
        bytes,
        filename(title, version, extension),
        extension === "pdf" ? "application/pdf" : "application/zip",
        request,
      ),
  };
}
