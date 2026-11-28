import { expect, open, test } from "nsh/test";

const fixture = "./fixtures/phone-host-setup.tsx";

test("phone: PhoneHostSetup offers Change host and Set up on this phone escape hatch", async () => {
  const app = await open(fixture, {
    width: 390,
    height: 844,
    locale: "en-US",
  });
  await app.waitFor("text:vps-a isn't ready yet");
  expect(app.shows("label:Set up on this phone")).toBe(true);
  expect(app.shows("label:Change host")).toBe(true);

  await app.press("label:Change host");
  expect(app.shows("text:Connect clicks: 1")).toBe(true);

  // Tapping "Set up on this phone" bypasses the waitingForHost gate and lands in Settings.
  await app.press("label:Set up on this phone");
  await app.waitFor("label:Model services");
  expect(app.shows("text:vps-a isn't ready yet")).toBe(false);
  expect(app.shows("label:Agents")).toBe(true);
  expect(app.shows("label:Hosts")).toBe(true);

  // User can drill into Model services on the phone to configure providers.
  await app.press("label:Model services");
  await app.waitFor("label:Add source");
  await app.press("label:Back");
  await app.waitFor("label:Model services");

  // Closing Settings lands in the workspace without trapping back into PhoneHostSetup.
  await app.press("label:Back");
  await app.waitFor("text:More");
  expect(app.shows("text:vps-a isn't ready yet")).toBe(false);

  // Switching to a different unconfigured host resets the session dismissal.
  await app.press("label:Switch to Host B");
  await app.waitFor("text:vps-b isn't ready yet");
  expect(app.shows("label:Set up on this phone")).toBe(true);
});

test("phone: ReconnectingBanner keeps Change host accessible", async () => {
  const app = await open(fixture, {
    width: 390,
    height: 844,
    locale: "en-US",
    storage: { mode: "banner" },
  });
  await app.waitFor("label:Change host");
  expect(app.shows("text:/Connection lost/")).toBe(true);
  await app.press("label:Change host");
  expect(app.shows("text:Connect clicks: 1")).toBe(true);
});
