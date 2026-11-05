import { expect, open, test } from "nsh/test";

test("the fake host opens the tabs", async () => {
  const app = await open("../../DevApp.tsx", {
    storage: { "eta.host": JSON.stringify({ address: "fake", token: "" }), "eta.language": "zh" },
  });
  await app.waitFor("id:tab-conversations");
  await app.press("id:tab-conversations");
  expect(app.texts()).toContain("任务");
});
