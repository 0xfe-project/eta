import { expect, open, test } from "nsh/test";

test("the creator row names the user as me, an agent by name, a deleted agent as deleted", async () => {
  const app = await open("./fixtures/task-creator-row.tsx", {
    width: 400,
    height: 300,
    locale: "en-US",
  });
  await app.waitUntil(() => app.texts().includes("Ada"));
  const texts = app.texts();
  expect(texts).toContain("Me");
  expect(texts).toContain("Ada");
  expect(texts).toContain("Deleted agent");
});
