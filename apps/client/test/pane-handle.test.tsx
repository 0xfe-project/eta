import { expect, open, test } from "nsh/test";

// The panel's drag handle is on the desktop layout only; a tablet or a phone shows the panel as a
// drawer and has no handle. The drag itself, and the width kept across a restart, are shown in
// the PR with a real browser.

for (const [name, width, height, handle] of [
  ["desktop", 1440, 900, true],
  ["tablet", 834, 1112, false],
  ["phone", 390, 844, false],
] as const)
  test(`the panel has a resize handle on the desktop layout only (${name})`, async () => {
    const app = await open("./fixtures/conversation-layout.tsx", {
      width,
      height,
      locale: "en-US",
      urlScheme: "eta://fixture/short",
    });
    expect(app.shows("text:Pong.")).toBe(true);
    expect(app.shows("label:Resize panel")).toBe(handle);
  });
