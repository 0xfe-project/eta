import { expect, open, test } from "nsh/test";

test("each installed plugin card shows its own Enabled switch, and an off one says so", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", { width: 1100, height: 700 });
  expect(app.shows("on-plugin")).toBe(true);
  expect(app.shows("off-plugin")).toBe(true);
  expect(app.shows("Enabled")).toBe(true);
  expect(app.shows("Off for all agents")).toBe(true);
});

test("the Settings button of a card opens its servers and headers, with the Authorization default", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", { width: 1100, height: 800 });
  await app.press("label:Settings >> nth=0");
  expect(app.shows("Settings · remote-plugin")).toBe(true);
  expect(app.shows("MCP servers")).toBe(true);
  expect(app.shows("Request headers")).toBe(true);
  expect(app.shows("Add Authorization (Bearer token)")).toBe(true);
  expect(app.shows("Add custom header")).toBe(true);
  expect(app.shows("Save headers")).toBe(true);
});

test("a click on the card body opens the same panel; the switch does not", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", { width: 1100, height: 800 });
  await app.press("label:Enabled >> nth=1");
  expect(app.shows("Settings · ")).toBe(false);
  await app.press("label:remote-plugin");
  expect(app.shows("Settings · remote-plugin")).toBe(true);
});

test("a host too old to send headers says so instead of hiding the editor", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", { width: 1100, height: 800 });
  await app.press("label:old-host-plugin");
  expect(app.shows("This host is too old for request headers. Update the host to set them.")).toBe(true);
});

test("each server offers a Test connection button, and nothing is tested until it is pressed", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", { width: 1100, height: 800 });
  await app.press("label:remote-plugin");
  expect(app.shows("Test connection")).toBe(true);
  expect(app.count("id:test-slot:fc")).toBe(1);
  expect(app.count("id:test-slot:fc >> label:Test connection")).toBe(1);
  expect(app.shows("Connected")).toBe(false);
  expect(app.shows("Failed")).toBe(false);
});

test("the Settings panel lists the plugin's skills: one, many, and none", async () => {
  const one = await open("./fixtures/plugins-installed.tsx", { width: 1100, height: 800 });
  await one.press("label:remote-plugin");
  expect(one.shows("only-skill")).toBe(true);
  expect(one.count("id:skill-card:only-skill")).toBe(1);
  expect(one.shows("<b>x</b> does one thing")).toBe(true);
  const many = await open("./fixtures/plugins-installed.tsx", { width: 1100, height: 800 });
  await many.press("label:old-host-plugin");
  expect(many.shows("alpha")).toBe(true);
  expect(many.count("id:skill-card:alpha")).toBe(1);
  expect(many.count("id:skill-card:gamma")).toBe(1);
  expect(many.shows("gamma skill")).toBe(true);
  const none = await open("./fixtures/plugins-installed.tsx", { width: 1100, height: 800 });
  await none.press("label:on-plugin");
  expect(none.shows("No skills")).toBe(true);
});

test("a server's badge shows only what has evidence, and never says ready", async () => {
  const open1 = async (name: string) => {
    const app = await open("./fixtures/plugins-installed.tsx", { width: 1100, height: 800 });
    await app.press("label:" + name);
    return app;
  };
  const plain = await open1("remote-plugin");
  expect(plain.shows("Not checked")).toBe(true);
  expect(plain.shows("Ready")).toBe(false);
  expect(plain.count("id:login-slot:fc >> label:Log in")).toBe(0);
  const signed = await open1("signed-plugin");
  expect(signed.shows("Signed in")).toBe(true);
  expect(signed.shows("Log out")).toBe(true);
  expect(signed.shows("Ready")).toBe(false);
  const login = await open1("login-plugin");
  expect(login.shows("Needs login")).toBe(true);
  expect(login.count("id:login-slot:fc >> label:Log in")).toBe(1);
  const setup = await open1("setup-plugin");
  expect(setup.shows("Needs setup")).toBe(true);
  expect(setup.shows("Ready")).toBe(false);
});

test("test results list each tool as a card with chips, fold long text, and count prompts as a number", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", { width: 1100, height: 900 });
  await app.press("label:remote-plugin");
  await app.press("label:Test connection");
  expect(app.shows("Tools (3)")).toBe(true);
  expect(app.count("id:tool-card:tool_0")).toBe(1);
  expect(app.count("id:tool-card:tool_2")).toBe(1);
  expect(app.shows("fake 1.0 · 3 tools · 2 resources · 1 prompt")).toBe(true);
  expect(app.shows("+3")).toBe(true);
  expect(app.count("id:tool-param:p0")).toBe(1);
  expect(app.shows("Show more")).toBe(true);
  await app.press("label:Show more");
  expect(app.shows("Show less")).toBe(true);
});

test("sixty tools still list inside one scrolling region with a count header", async () => {
  const app = await open("./fixtures/plugins-many-tools.tsx", { width: 1100, height: 900 });
  await app.press("label:remote-plugin");
  await app.press("label:Test connection");
  expect(app.shows("Tools (60)")).toBe(true);
  expect(app.count("id:tool-card:tool_0")).toBe(1);
});

test("each installed card has exactly one avatar in its header, and no default plugin icon", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", { width: 1100, height: 900 });
  // The fixture lists eight installed plugins; one avatar each, not two.
  expect(app.count("id:plugin-avatar")).toBe(8);
});

test("a card shows its login only with evidence: needs login, signed in, and nothing otherwise", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", { width: 1100, height: 900 });
  expect(app.count("id:card-login:login-plugin")).toBe(1);
  expect(app.count("id:card-login:signed-plugin")).toBe(1);
  expect(app.count("id:card-login:expired-plugin")).toBe(1);
  expect(app.shows("Sign-in expired")).toBe(true);
  expect(app.count("id:card-login:remote-plugin")).toBe(0);
  expect(app.count("id:card-login:on-plugin")).toBe(0);
});
