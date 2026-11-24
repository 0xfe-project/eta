import { expect, open, test } from "nsh/test";

test("ui text primitives render labels, captions, and semantic icons", async () => {
  const app = await open("./fixtures/ui-text.tsx", { width: 600, height: 400 });
  expect(app.shows("text:Regular body")).toBe(true);
  expect(app.shows("text:bun test")).toBe(true);
  expect(app.shows("text:SECTION")).toBe(true);
  expect(app.shows("label:Verified")).toBe(true);
});
