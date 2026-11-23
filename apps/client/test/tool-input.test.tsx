import { expect, open, test } from "nsh/test";

// A tool call's input, opened in a run: an object as JSON in a code block, a command line as code,
// with the code block's Copy giving the text as shown.

const json = `{
  "path": ".notes",
  "title": "Notes",
  "spa": false
}`;

test("an object input shows as JSON in a code block whose Copy copies it", async () => {
  const app = await open("./fixtures/tool-input.tsx", {
    width: 1440,
    height: 900,
    platform: "macos",
  });
  await app.press("View process");
  await app.press("label:publish_artifact · .notes");
  await app.waitFor("id:tool-input");
  const shown = app.texts().join("");
  expect(shown).toContain('"title"');
  expect(shown).toContain('"Notes"');
  // The output is still there, as it was written.
  expect(app.shows("Published as artifact a1, version 2.")).toBe(true);
  await app.press("id:tool-input >> label:Copy code");
  expect(app.clipboard()).toBe(json);
});

test("a command line given as a string shows as code, copied as it is", async () => {
  const app = await open("./fixtures/tool-input.tsx", {
    width: 1440,
    height: 900,
    platform: "macos",
  });
  await app.press("View process");
  await app.press("label:bash · ls -la | grep notes");
  await app.waitFor("id:tool-input");
  expect(app.texts().join("")).toContain("grep");
  await app.press("id:tool-input >> label:Copy code");
  expect(app.clipboard()).toBe("ls -la | grep notes");
});
