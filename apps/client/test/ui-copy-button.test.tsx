import { expect, open, test } from "nsh/test";

test("CopyButton switches to Copied state after pressing", async () => {
  const app = await open("./fixtures/ui-copy-button.tsx", {
    width: 600,
    height: 400,
    locale: "en-US",
  });
  expect(app.shows("Copy token")).toBe(true);
  await app.press("Copy token");
  expect(app.shows("Copied")).toBe(true);
});
