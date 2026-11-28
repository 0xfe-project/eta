import { expect, open, test } from "nsh/test";

const fixture = "./fixtures/attachment-save.tsx";
// The home directory as the app names it to NSH, before NSH expands the placeholder.
const home = `\${homeDir}`;
const downloads = `${home}/Downloads`;
const network = {
  "GET http://host.test/attachments/a1": {
    headers: { "content-type": "text/plain" },
    body: "quarterly numbers",
  },
};

/** The app's files, in memory: what it writes, keyed by the path it gives. */
function memoryFiles() {
  const files = new Map<string, Uint8Array>();
  const missing = (path: string) =>
    Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  const module = {
    mkdir: () => undefined,
    exists: (path: string) => files.has(path),
    // Bytes reach a module mock as a plain object keyed by index.
    writeFile: (path: string, data: Record<number, number>) => {
      files.set(path, Uint8Array.from(Object.values(data)));
    },
    stat: (path: string) => {
      const data = files.get(path);
      if (!data) throw missing(path);
      return { size: data.length, mtimeMs: 0 };
    },
    unlink: (path: string) => {
      if (!files.delete(path)) throw missing(path);
    },
    readdir: () => [],
    rmdir: () => undefined,
    rename: (from: string, to: string) => {
      const data = files.get(from);
      if (!data) throw missing(from);
      files.delete(from);
      files.set(to, data);
    },
  };
  return { files, module };
}

/** The machine a test runs on: its platform, home directory and the Downloads folder it names. */
interface Machine {
  platform: "macos" | "linux" | "windows";
  home: string;
  /** What `Directories.userDirs()` reports as `downloadDir`; `null` when it names none. */
  downloadDir: string | null;
}

const mac: Machine = {
  platform: "macos",
  home: "/Users/tester",
  downloadDir: "/Users/tester/Downloads",
};

async function openOn(machine: Machine | "ios", fs = memoryFiles()) {
  const on =
    machine === "ios"
      ? { platform: "ios" as const, home: "/var/mobile", downloadDir: null }
      : machine;
  const shared: { files?: string[] }[] = [];
  const app = await open(fixture, {
    width: 1280,
    height: 800,
    locale: "en-US",
    platform: on.platform,
    network,
    modules: {
      "fs/promises": fs.module,
      os: { homedir: on.home },
      "nsh-directories": {
        "Directories.available": true,
        "Directories.userDirs":
          on.platform === "ios"
            ? { homeDir: on.home, documentDir: `${on.home}/Documents` }
            : { homeDir: on.home, downloadDir: on.downloadDir },
      },
      nsh: {
        "Share.available": () => true,
        "Share.show": (content: { files?: string[] }) => {
          shared.push(content);
          return { action: "shared" };
        },
      },
    },
  });
  return { app, files: fs.files, shared };
}

test("a desktop saves a message file into Downloads, without the share sheet", async () => {
  const { app, files, shared } = await openOn(mac);
  await app.press("label:Save report");
  await app.waitFor("text:Saved to your Downloads folder · report.txt");
  expect([...files.keys()]).toEqual([`${downloads}/report.txt`]);
  expect(new TextDecoder().decode(files.get(`${downloads}/report.txt`))).toBe(
    "quarterly numbers",
  );
  expect(shared).toEqual([]);
  expect(app.texts()).toContain("/Users/tester/Downloads/report.txt");
});

test("a second save of the same name gets a numbered name", async () => {
  const { app, files } = await openOn(mac);
  await app.press("label:Save report");
  await app.waitFor("text:Saved to your Downloads folder · report.txt");
  await app.press("label:Close");
  await app.press("label:Save report");
  await app.waitFor("text:Saved to your Downloads folder · report (1).txt");
  expect([...files.keys()]).toEqual([
    `${downloads}/report.txt`,
    `${downloads}/report (1).txt`,
  ]);
  expect(app.texts()).toContain("/Users/tester/Downloads/report (1).txt");
});

test("Copy path puts the saved file's full path on the clipboard", async () => {
  const { app } = await openOn(mac);
  await app.press("label:Save report");
  await app.waitFor("text:Saved to your Downloads folder · report.txt");
  await app.press("label:Copy path");
  expect(app.clipboard()).toBe("/Users/tester/Downloads/report.txt");
});

test("a phone still saves through the share sheet", async () => {
  const { app, shared } = await openOn("ios");
  await app.press("label:Save report");
  await app.waitUntil(() => shared.length === 1);
  expect(shared[0]?.files?.[0]).toMatch(/report\.txt$/);
});

test("Linux saves into the Downloads folder user-dirs.dirs names, without making ~/Downloads", async () => {
  const { app, files, shared } = await openOn({
    platform: "linux",
    home: "/home/tester",
    downloadDir: "/home/tester/下载",
  });
  await app.press("label:Save report");
  await app.waitFor("text:Saved to your Downloads folder · report.txt");
  expect([...files.keys()]).toEqual([`${home}/下载/report.txt`]);
  expect(shared).toEqual([]);
  expect(app.texts()).toContain("/home/tester/下载/report.txt");
});

test("Windows saves into a Downloads folder moved elsewhere in the home folder", async () => {
  const { app, files } = await openOn({
    platform: "windows",
    home: "C:\\Users\\tester",
    downloadDir: "c:\\users\\tester\\Files\\Incoming",
  });
  await app.press("label:Save report");
  await app.waitFor("text:Saved to your Downloads folder · report.txt");
  expect([...files.keys()]).toEqual([`${home}/Files/Incoming/report.txt`]);
  expect(app.texts()).toContain(
    "c:\\users\\tester\\Files\\Incoming\\report.txt",
  );
});

test("with no Downloads folder named, a desktop saves into ~/Downloads", async () => {
  const { app, files } = await openOn({
    platform: "linux",
    home: "/home/tester",
    downloadDir: null,
  });
  await app.press("label:Save report");
  await app.waitFor("text:Saved to your Downloads folder · report.txt");
  expect([...files.keys()]).toEqual([`${downloads}/report.txt`]);
  expect(app.texts()).toContain("/home/tester/Downloads/report.txt");
});

test("a Downloads folder outside the home folder goes through the share sheet, saying why", async () => {
  const { app, files, shared } = await openOn({
    platform: "windows",
    home: "C:\\Users\\tester",
    downloadDir: "D:\\Downloads",
  });
  await app.press("label:Save report");
  await app.waitFor("text:Not saved to Downloads · report.txt");
  expect(shared).toHaveLength(1);
  expect(shared[0]?.files?.[0]).toMatch(/report\.txt$/);
  expect([...files.keys()].some((path) => path.startsWith(home))).toBe(false);
  expect(app.texts()).toContain(
    "Eta can only write inside your home folder, and your Downloads folder is D:\\Downloads, so the share sheet saves it instead.",
  );
});
