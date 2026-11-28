import { expect, open, test } from "nsh/test";

// The empty rows' padding (#1053) is geometry: it is shown in the PR with a browser run (#639).
const fixture = "./fixtures/context-empty-padding.tsx";

test("Context panel task, artifact and member empty states say so, with one View all tasks", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 900,
    locale: "en-US",
  });
  await app.waitFor("text:No artifacts yet");

  expect(app.shows("id:context-tasks-empty >> text:No tasks yet")).toBe(true);
  expect(app.shows("id:context-tasks-no-open >> text:No open tasks")).toBe(
    true,
  );
  expect(app.shows("id:context-artifacts-empty >> text:No artifacts yet")).toBe(
    true,
  );
  expect(app.shows("id:context-members-empty >> text:No members yet")).toBe(
    true,
  );

  // ViewAll in SectionHeading stays rendered, with no duplicate button in the empty row (#1075).
  expect(
    app.shows("id:context-tasks-no-open >> label:View all tasks >> nth=0"),
  ).toBe(true);
  expect(
    app.shows("id:context-tasks-no-open >> label:View all tasks >> nth=1"),
  ).toBe(false);
});
