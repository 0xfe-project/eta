import { expect, open, test } from "nsh/test";

const fixture = "./fixtures/files-panel.tsx";

test("browses directories, filters entries, previews files, and mentions into composer (desktop)", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 900,
    locale: "en-US",
  });
  await app.press("label:Files");
  await app.waitFor("text:rivus-us · ~/rivus");
  await app.waitFor("text:README.md");

  expect(app.shows("text:src")).toBe(true);
  expect(app.shows("text:.gitignore")).toBe(true);
  expect(app.shows("text:logo.bin")).toBe(true);

  // Filter within the current folder.
  await app.type("label:Filter files", "read");
  expect(app.shows("text:README.md")).toBe(true);
  expect(app.shows("text:src")).toBe(false);
  await app.press("label:Clear filter");
  expect(app.shows("text:src")).toBe(true);

  // Navigate into a subdirectory and preview a source file.
  await app.press("label:src");
  await app.waitFor("text:app.ts");
  expect(app.shows("text:huge.log")).toBe(true);

  await app.press("label:app.ts");
  await app.waitFor("text:src/app.ts · 33 B");
  expect(app.shows("text:export const greeting = 'hello';")).toBe(true);

  // Mentioning inserts @path into the composer and closes the modal.
  await app.press("label:Mention");
  await app.waitUntil(() => !app.shows("text:src/app.ts · 33 B"));
  expect(app.texts().some((text) => text.includes("@src/app.ts"))).toBe(true);

  // Navigate back to the root via parent folder button.
  await app.press("label:Parent folder");
  await app.waitFor("text:README.md");
});

test("shows binary refusal and truncation notice in file preview", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 900,
    locale: "en-US",
  });
  await app.press("label:Files");
  await app.waitFor("text:logo.bin");

  await app.press("label:logo.bin");
  await app.waitFor("text:Binary file");
  expect(app.shows("text:This file can't be previewed as text.")).toBe(true);
  await app.press("label:Close");
  await app.waitUntil(() => !app.shows("text:Binary file"));

  await app.press("label:src");
  await app.waitFor("text:huge.log");
  await app.press("label:huge.log");
  await app.waitFor("text:Showing the first 256 KB of 512 KB.");
});

test("opens workspace browser from the phone conversation info sheet", async () => {
  const app = await open(fixture, { width: 390, height: 844, locale: "en-US" });
  await app.press("label:Conversation info");
  await app.waitFor("text:Browse workspace");
  await app.press("text:Browse workspace");
  await app.waitFor("text:README.md");
  await app.press("label:README.md");
  await app.waitFor("text:README.md · 26 B");
});

test("hides the Files tab when connected to a host without projects.directory", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 900,
    locale: "en-US",
    urlScheme: "eta://fixture/legacy",
  });
  expect(app.shows("label:Artifacts")).toBe(true);
  expect(app.shows("label:Files")).toBe(false);
});
