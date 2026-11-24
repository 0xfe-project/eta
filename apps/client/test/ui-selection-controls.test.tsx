import { expect, open, test } from "nsh/test";

test("CheckControl and ToggleSwitch toggle state cleanly", async () => {
  const app = await open("./fixtures/ui-selection-controls.tsx", {
    width: 600,
    height: 400,
  });
  expect(app.shows("text:agreed:false enabled:true")).toBe(true);
  await app.press("label:Agree");
  expect(app.shows("text:agreed:true enabled:true")).toBe(true);
  await app.press("label:Enable sync");
  expect(app.shows("text:agreed:true enabled:false")).toBe(true);
});
