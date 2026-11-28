import { expect, open, test } from "nsh/test";

const OPEN = { width: 1000, height: 800 };

test("Composio-only market renders toolkits without EmptyState", async () => {
  const app = await open("./fixtures/market-phase1-2.tsx", OPEN);
  expect(app.shows("Gmail")).toBe(true);
  expect(app.shows("No plugins in these sources yet")).toBe(false);
});

test("cold-start empty cache shows loading instead of flashing empty while network fetch is running", async () => {
  const app = await open("./fixtures/market-phase1-2.tsx", OPEN);
  await app.press("label:mode-cold-cache");
  await app.waitFor("label:Loading the market…");
  expect(app.shows("No plugins in these sources yet")).toBe(false);
});

test("Composio needs-key notice shows Open Settings button and does not render empty-market EmptyState", async () => {
  const app = await open("./fixtures/market-phase1-2.tsx", OPEN);
  await app.press("label:mode-needs-key");
  expect(app.shows("Composio needs an API key")).toBe(true);
  expect(app.shows("No plugins in these sources yet")).toBe(false);
  await app.press("label:Open Settings → Plugins");
  expect(app.shows("text:settings-clicks:1")).toBe(true);
});

test("preview surfaces manifestName mismatch and server missingEnv", async () => {
  const app = await open("./fixtures/market-phase1-2.tsx", OPEN);
  await app.press("label:mode-manifest-diff");
  await app.press("label:catalog-alias");
  await app.waitFor("text:real-manifest-name");
  expect(app.shows("Installs as")).toBe(true);
  expect(app.shows("real-manifest-name")).toBe(true);
  expect(app.shows("Required environment variables: SERVICE_API_KEY")).toBe(
    true,
  );
});
