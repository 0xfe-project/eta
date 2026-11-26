import { expect, open, test } from "nsh/test";

const fixture = "./fixtures/attachment-save.tsx";
// The Downloads folder as the app names it to NSH, before NSH expands the placeholder.
const downloads = `\${homeDir}/Downloads`;
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

async function openOn(platform: "macos" | "ios", fs = memoryFiles()) {
  const shared: { files?: string[] }[] = [];
  const app = await open(fixture, {
    width: 1280,
    height: 800,
    locale: "en-US",
    platform,
    network,
    modules: {
      "fs/promises": fs.module,
      os: { homedir: "/Users/tester" },
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
  const { app, files, shared } = await openOn("macos");
  await app.press("label:Save report");
  await app.waitFor("text:Saved to Downloads · report.txt");
  expect([...files.keys()]).toEqual([`${downloads}/report.txt`]);
  expect(new TextDecoder().decode(files.get(`${downloads}/report.txt`))).toBe(
    "quarterly numbers",
  );
  expect(shared).toEqual([]);
  expect(app.texts()).toContain("/Users/tester/Downloads/report.txt");
});

test("a second save of the same name gets a numbered name", async () => {
  const { app, files } = await openOn("macos");
  await app.press("label:Save report");
  await app.waitFor("text:Saved to Downloads · report.txt");
  await app.press("label:Close");
  await app.press("label:Save report");
  await app.waitFor("text:Saved to Downloads · report (1).txt");
  expect([...files.keys()]).toEqual([
    `${downloads}/report.txt`,
    `${downloads}/report (1).txt`,
  ]);
  expect(app.texts()).toContain("/Users/tester/Downloads/report (1).txt");
});

test("Copy path puts the saved file's full path on the clipboard", async () => {
  const { app } = await openOn("macos");
  await app.press("label:Save report");
  await app.waitFor("text:Saved to Downloads · report.txt");
  await app.press("label:Copy path");
  expect(app.clipboard()).toBe("/Users/tester/Downloads/report.txt");
});

test("a phone still saves through the share sheet", async () => {
  const { app, shared } = await openOn("ios");
  await app.press("label:Save report");
  await app.waitUntil(() => shared.length === 1);
  expect(shared[0]?.files?.[0]).toMatch(/report\.txt$/);
});
