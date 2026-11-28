import { expect, open, test } from "nsh/test";

const OPEN = { width: 1100, height: 850 };

test("empty stdio env plugin exposes Configure action, MissingValues inline env input, pre-populated EnvEditor, and warnings", async () => {
  const app = await open("./fixtures/plugins-config-phase1-2.tsx", OPEN);
  expect(app.shows("env-only-plugin")).toBe(true);
  expect(app.shows("label:Configure")).toBe(true);
  await app.press("label:Warnings for env-only-plugin");
  expect(
    app.shows(
      'Required environment variable "DB_TOKEN" for server "local" is missing.',
    ),
  ).toBe(true);
  await app.press("label:OK");
  await app.press("label:Configure");
  expect(app.count("id:missing-values")).toBe(1);
  expect(app.shows("Missing before it can run: DB_TOKEN")).toBe(true);
  expect(app.shows("Required before it can run: DB_TOKEN")).toBe(true);
});

test("warnings and ConfigurePlugin format non-required FieldIssue codes, show Clear on saved optional select, allow saving required boolean false, and explain remaining missingEnv", async () => {
  const app = await open("./fixtures/plugins-config-phase1-2.tsx", OPEN);
  await app.press("label:Warnings for config-edges-plugin");
  expect(app.shows('Field "Access Code": Must be at least 6 characters.')).toBe(
    true,
  );
  await app.press("label:OK");
  await app.press("label:Values");
  expect(app.shows("Must be at least 6 characters.")).toBe(true);
  expect(app.shows("label:Clear")).toBe(true);
  // Required boolean defaults visually to false and enables Save immediately.
  await app.press("label:Save");
  await app.waitFor("id:configure-submit-note");
  expect(
    app.shows(
      "Saved, but this plugin still needs server environment variables before it can run: WORKER_SECRET",
    ),
  ).toBe(true);
  expect(app.shows("label:Open server settings")).toBe(true);
});

test("useComposioPlugins follows live plugins.toolkits wire section updates", async () => {
  const app = await open("./fixtures/plugins-config-phase1-2.tsx", OPEN);
  expect(app.shows("text:live:@composio/slack:ready")).toBe(true);
  await app.press("label:Push toolkit");
  await app.waitFor("text:live:@composio/slack:ready,@composio/linear:ready");
});
