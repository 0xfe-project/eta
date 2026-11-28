import { expect, open, test } from "nsh/test";
import { LEGACY_HOST_KEY, SAVED_HOSTS_KEY } from "../src/app/saved-hosts";

const fixture = "./fixtures/multi-host.tsx";

const twoHosts = JSON.stringify([
  {
    origin: "https://prod.example.com",
    name: "Prod VPS",
    token: "prod-token",
    lastConnectedAt: 2_000,
  },
  {
    origin: "https://staging.example.com",
    token: "stage-token",
    lastConnectedAt: 1_000,
  },
]);

test("desktop: connection screen shows saved hosts, supports one-click connect, in-app rename, cancelable Add host, switch, and remove", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 900,
    locale: "en-US",
    platform: "linux",
    storage: {
      [SAVED_HOSTS_KEY]: twoHosts,
    },
  });

  // Cold start on Connection screen shows both saved hosts.
  await app.waitFor("label:Prod VPS");
  expect(app.shows("label:staging.example.com")).toBe(true);

  // One-click connect to Prod VPS lands in Workspace.
  await app.press("label:Prod VPS");
  await app.waitFor("text:Group on prod.example.com");
  expect(app.shows("text:Active: https://prod.example.com")).toBe(true);

  // Open Settings -> Hosts inside the connected app.
  await app.press("label:Settings");
  await app.waitFor("label:Hosts");
  await app.press("label:Hosts");
  await app.waitFor("text:Connected");
  expect(app.shows("label:Prod VPS")).toBe(true);
  expect(app.shows("label:staging.example.com")).toBe(true);

  // Rename staging.example.com -> Staging Box.
  await app.press("label:Actions for staging.example.com");
  await app.waitFor("label:Rename");
  await app.press("label:Rename");
  await app.waitFor("label:Host name");
  await app.type("label:Host name", "Staging Box");
  await app.press("label:Save");
  await app.waitFor("label:Staging Box");

  // Open Connection screen via Add host while connected, then Cancel back to live workspace.
  await app.press("label:Add host");
  await app.waitFor("label:Cancel");
  expect(app.shows("label:Staging Box")).toBe(true);
  await app.press("label:Cancel");
  await app.waitFor("text:Group on prod.example.com");
  expect(app.shows("text:Active: https://prod.example.com")).toBe(true);

  // Add and connect to a brand-new third host; verify it is automatically saved.
  await app.press("label:Settings");
  await app.waitFor("label:Hosts");
  await app.press("label:Hosts");
  await app.waitFor("label:Add host");
  await app.press("label:Add host");
  await app.waitFor("label:Host address");
  await app.type("label:Host address", "https://newbox.example.com");
  await app.press("label:Connect");
  await app.waitFor("text:Group on newbox.example.com");
  expect(app.shows("text:Active: https://newbox.example.com")).toBe(true);

  // Switch directly from Settings -> Hosts to Staging Box, and verify newbox was saved.
  await app.press("label:Settings");
  await app.waitFor("label:Hosts");
  await app.press("label:Hosts");
  await app.waitFor("label:newbox.example.com");
  expect(app.shows("label:Staging Box")).toBe(true);
  await app.press("label:Staging Box");
  await app.waitFor("text:Group on staging.example.com");
  expect(app.shows("text:Active: https://staging.example.com")).toBe(true);

  // Reopen Settings -> Hosts and remove Prod VPS.
  await app.press("label:Settings");
  await app.waitFor("label:Hosts");
  await app.press("label:Hosts");
  await app.waitFor("label:Actions for Prod VPS");
  await app.press("label:Actions for Prod VPS");
  await app.waitFor("label:Remove");
  await app.press("label:Remove");
  await app.waitUntil(() => !app.shows("label:Prod VPS"));
  expect(app.shows("label:Staging Box")).toBe(true);
  expect(app.shows("label:newbox.example.com")).toBe(true);
});

test("phone: migrates legacy eta.host, switches via More -> Hosts, and allows canceling Add host", async () => {
  const app = await open(fixture, {
    width: 390,
    height: 844,
    locale: "en-US",
    platform: "ios",
    storage: {
      autoConnect: "true",
      [LEGACY_HOST_KEY]: JSON.stringify({
        origin: "https://prod.example.com",
        token: "prod-token",
      }),
      [SAVED_HOSTS_KEY]: twoHosts,
    },
  });

  // Auto-connected to Prod VPS on phone.
  await app.waitFor("text:Group on prod.example.com");
  await app.press("label:More");
  await app.waitFor("label:Hosts");
  expect(app.shows("text:Prod VPS")).toBe(true);

  // Open Hosts from More -> see saved hosts and open Add host (phone connection form).
  await app.press("label:Hosts");
  await app.waitFor("label:staging.example.com");
  await app.press("label:Add host");
  await app.waitFor("label:Host address");
  expect(app.shows("label:Prod VPS")).toBe(true);

  // Back returns cleanly to the connected workspace on Prod VPS.
  await app.press("label:Back");
  await app.waitFor("text:Group on prod.example.com");
  expect(app.shows("text:Active: https://prod.example.com")).toBe(true);

  // Reopen More -> Hosts and switch directly to staging.example.com.
  await app.press("label:More");
  await app.waitFor("label:Hosts");
  await app.press("label:Hosts");
  await app.waitFor("label:staging.example.com");
  await app.press("label:staging.example.com");
  await app.waitFor("text:Group on staging.example.com");
  expect(app.shows("text:Active: https://staging.example.com")).toBe(true);
});

test("phone: unconfigured iOS host keeps phone setup dismissed across Hosts -> Add host -> Back round-trip", async () => {
  const app = await open(fixture, {
    width: 390,
    height: 844,
    locale: "en-US",
    platform: "ios",
    storage: {
      autoConnect: "true",
      unconfigured: "true",
      [LEGACY_HOST_KEY]: JSON.stringify({
        origin: "https://prod.example.com",
        token: "prod-token",
      }),
      [SAVED_HOSTS_KEY]: twoHosts,
    },
  });

  // Unconfigured phone host starts on PhoneHostSetup.
  await app.waitFor("text:Prod VPS isn't ready yet");
  await app.press("label:Set up on this phone");
  await app.waitFor("label:Hosts");

  // Open Hosts -> Add host -> Back (Cancel): Workspace remounts but must NOT re-trap in PhoneHostSetup.
  await app.press("label:Hosts");
  await app.waitFor("label:Add host");
  await app.press("label:Add host");
  await app.waitFor("label:Host address");
  await app.press("label:Back");
  await app.waitFor("label:More");
  expect(app.shows("text:Prod VPS isn't ready yet")).toBe(false);
  expect(app.shows("text:Active: https://prod.example.com")).toBe(true);

  // Switching to a different unconfigured host resets dismissal and shows PhoneHostSetup for it.
  await app.press("label:More");
  await app.waitFor("label:Hosts");
  await app.press("label:Hosts");
  await app.waitFor("label:staging.example.com");
  await app.press("label:staging.example.com");
  await app.waitFor("text:staging isn't ready yet");
  expect(app.shows("text:Active: https://staging.example.com")).toBe(true);
});

test("desktop: switching to a saved local host from Settings -> Hosts resumes local host on its live port", async () => {
  const withLocal = JSON.stringify([
    {
      origin: "https://prod.example.com",
      name: "Prod VPS",
      token: "prod-token",
      lastConnectedAt: 2_000,
    },
    {
      origin: "http://127.0.0.1:51111",
      name: "My Mac",
      token: "stale-local-token",
      local: true,
      lastConnectedAt: 1_000,
    },
  ]);

  const app = await open(fixture, {
    width: 1440,
    height: 900,
    locale: "en-US",
    platform: "macos",
    storage: {
      autoConnect: "true",
      canStartLocal: "true",
      [LEGACY_HOST_KEY]: JSON.stringify({
        origin: "https://prod.example.com",
        token: "prod-token",
      }),
      [SAVED_HOSTS_KEY]: withLocal,
    },
  });

  await app.waitFor("text:Group on prod.example.com");
  await app.press("label:Settings");
  await app.waitFor("label:Hosts");
  await app.press("label:Hosts");
  await app.waitFor("label:My Mac");

  // Switching to saved local host resumes via startLocalHost onto the new live port and preserves alias.
  await app.press("label:My Mac");
  await app.waitFor("text:Group on 127.0.0.1:54321");
  expect(app.shows("text:Active: http://127.0.0.1:54321")).toBe(true);
  expect(app.shows("text:Local launches: 1")).toBe(true);

  await app.press("label:Settings");
  await app.waitFor("label:Hosts");
  await app.press("label:Hosts");
  await app.waitFor("label:My Mac");
  expect(app.shows("text:/127\\.0\\.0\\.1:54321/")).toBe(true);
  expect(app.shows("text:/127\\.0\\.0\\.1:51111/")).toBe(false);
});
