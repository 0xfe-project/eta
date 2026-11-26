import { expect, open, test } from "nsh/test";

const fixture = "./fixtures/machines-remove.tsx";

for (const [width, height] of [
  [1440, 900],
  [390, 844],
] as const) {
  test(`RemoveMachine shows impact preview, cancels safely, and removes on confirmation at ${width}`, async () => {
    const app = await open(fixture, {
      width,
      height,
      locale: "en-US",
      urlScheme: "eta://fixture/settings",
    });
    await app.waitFor("text:gpu-box");
    await app.press("label:gpu-box");
    await app.waitFor("label:Remove");
    await app.press("label:Remove");

    await app.waitFor("text:Remove machine?");
    await app.waitFor("text:Cody (claude)");
    expect(app.texts()).toContain("PinnedAda (pinned built-in eta)");
    expect(app.texts()).toContain("remote-repo (/srv/repo)");
    expect(app.texts()).toContain("remote-chat");
    expect(app.texts()).toContain("old-chat (archived)");
    expect(app.texts()).toContain(
      "Will stop 1 active run(s) and 2 active reply(ies).",
    );

    // Cancel keeps gpu-box in the list.
    await app.press("label:Cancel");
    await app.waitUntil(() => !app.texts().includes("Remove machine?"));
    expect(app.texts()).toContain("gpu-box");

    // Re-open Remove and confirm.
    await app.press("label:Remove");
    await app.waitFor("label:Remove machine");
    await app.press("label:Remove machine");
    await app.waitUntil(() => !app.texts().includes("gpu-box"));
    expect(app.texts()).toContain("studio");
  });
}

test("Workspace falls back gracefully when the currently open conversation disappears after machine removal", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 900,
    locale: "en-US",
    urlScheme: "eta://fixture/workspace",
  });
  await app.waitFor("text:remote-chat");
  await app.press("label:Simulate machine removed");
  await app.waitUntil(() => !app.texts().includes("remote-chat"));
  expect(app.texts()).toContain("local-chat");
  expect(app.texts()).not.toContain("This conversation can't be opened");
});
