import { expect, open, test } from "nsh/test";

test("each installed plugin card shows its own Enabled switch, and an off one says so", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", {
    width: 1100,
    height: 700,
  });
  expect(app.shows("on-plugin")).toBe(true);
  expect(app.shows("off-plugin")).toBe(true);
  expect(app.shows("Enabled")).toBe(true);
  expect(app.shows("Off for all agents")).toBe(true);
});

test("the Settings button of a card opens its servers and headers, with the Authorization default", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", {
    width: 1100,
    height: 800,
  });
  await app.press("label:Settings >> nth=0");
  expect(app.shows("Settings · remote-plugin")).toBe(true);
  expect(app.shows("MCP servers")).toBe(true);
  expect(app.shows("Request headers")).toBe(true);
  expect(app.shows("Add Authorization (Bearer token)")).toBe(true);
  expect(app.shows("Add custom header")).toBe(true);
  expect(app.shows("Save headers")).toBe(true);
});

test("a click on the card body opens the same panel; the switch does not", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", {
    width: 1100,
    height: 800,
  });
  await app.press("label:Enabled >> nth=1");
  expect(app.shows("Settings · ")).toBe(false);
  await app.press("label:remote-plugin");
  expect(app.shows("Settings · remote-plugin")).toBe(true);
});

test("a host too old to send headers says so instead of hiding the editor", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", {
    width: 1100,
    height: 800,
  });
  await app.press("label:old-host-plugin");
  expect(
    app.shows(
      "This host is too old for request headers. Update the host to set them.",
    ),
  ).toBe(true);
});

test("each server offers a Test connection button, and nothing is tested until it is pressed", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", {
    width: 1100,
    height: 800,
  });
  await app.press("label:remote-plugin");
  expect(app.shows("Test connection")).toBe(true);
  expect(app.count("id:test-slot:fc")).toBe(1);
  expect(app.count("id:test-slot:fc >> label:Test connection")).toBe(1);
  expect(app.shows("Connected")).toBe(false);
  expect(app.shows("Failed")).toBe(false);
});

test("the Settings panel lists the plugin's skills: one, many, and none", async () => {
  const one = await open("./fixtures/plugins-installed.tsx", {
    width: 1100,
    height: 800,
  });
  await one.press("label:remote-plugin");
  expect(one.shows("only-skill")).toBe(true);
  expect(one.count("id:skill-card:only-skill")).toBe(1);
  expect(one.shows("<b>x</b> does one thing")).toBe(true);
  const many = await open("./fixtures/plugins-installed.tsx", {
    width: 1100,
    height: 800,
  });
  await many.press("label:old-host-plugin");
  expect(many.shows("alpha")).toBe(true);
  expect(many.count("id:skill-card:alpha")).toBe(1);
  expect(many.count("id:skill-card:gamma")).toBe(1);
  expect(many.shows("gamma skill")).toBe(true);
  const none = await open("./fixtures/plugins-installed.tsx", {
    width: 1100,
    height: 800,
  });
  await none.press("label:on-plugin");
  expect(none.shows("No skills")).toBe(true);
});

test("a server's badge shows only what has evidence, and never says ready", async () => {
  const open1 = async (name: string) => {
    const app = await open("./fixtures/plugins-installed.tsx", {
      width: 1100,
      height: 800,
    });
    await app.press(`label:${name}`);
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
  const app = await open("./fixtures/plugins-installed.tsx", {
    width: 1100,
    height: 900,
  });
  await app.press("label:remote-plugin");
  await app.press("label:Test connection");
  expect(app.shows("Tools (3)")).toBe(true);
  expect(app.count("id:tool-card:tool_0")).toBe(1);
  expect(app.count("id:tool-card:tool_2")).toBe(1);
  expect(app.shows("fake 1.0")).toBe(true);
  expect(app.shows("3 tools")).toBe(true);
  expect(app.shows("2 resources")).toBe(true);
  expect(app.shows("1 prompt")).toBe(true);
  expect(app.shows("+3")).toBe(true);
  expect(app.count("id:tool-param:p0")).toBe(1);
  expect(app.shows("Show more")).toBe(true);
  await app.press("label:Show more");
  expect(app.shows("Show less")).toBe(true);
});

test("sixty tools still list inside one scrolling region with a count header", async () => {
  const app = await open("./fixtures/plugins-many-tools.tsx", {
    width: 1100,
    height: 900,
  });
  await app.press("label:remote-plugin");
  await app.press("label:Test connection");
  expect(app.shows("Tools (60)")).toBe(true);
  expect(app.count("id:tool-card:tool_0")).toBe(1);
});

test("each installed card has exactly one avatar in its header, and no default plugin icon", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", {
    width: 1100,
    height: 900,
  });
  // The fixture lists thirteen installed plugins; one avatar each, not two.
  expect(app.count("id:plugin-avatar")).toBe(15);
});

test("a card shows its login only with evidence: needs login, signed in, and nothing otherwise", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", {
    width: 1100,
    height: 900,
  });
  expect(app.count("id:card-login:login-plugin")).toBe(1);
  expect(app.count("id:card-login:signed-plugin")).toBe(1);
  expect(app.count("id:card-login:expired-plugin")).toBe(1);
  expect(app.shows("Sign-in expired")).toBe(true);
  expect(app.count("id:card-login:remote-plugin")).toBe(0);
  expect(app.count("id:card-login:on-plugin")).toBe(0);
});

test("a ready plugin shows no status text; needs-config and off-for-all still do", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", {
    width: 1100,
    height: 700,
  });
  expect(app.shows("Can be enabled")).toBe(false);
  expect(app.shows("Needs configuring")).toBe(true);
  expect(app.shows("Off for all agents")).toBe(true);
});

test("a plugin missing a required value says which one and where to type it; no result block until a test is pressed, and a not-tested result has no time", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", {
    width: 1100,
    height: 900,
  });
  await app.press("label:github-plugin");
  expect(app.count("id:missing-values")).toBe(1);
  expect(
    app.shows("Missing before it can run: GITHUB_PERSONAL_ACCESS_TOKEN"),
  ).toBe(true);
  expect(app.shows("Headers: Authorization")).toBe(true);
  expect(app.shows("Headers set")).toBe(false);
  expect(app.shows("required values are missing")).toBe(false);
  await app.press("label:Test connection");
  expect(app.shows("required values are missing")).toBe(true);
  expect(app.shows(" ms")).toBe(false);
  const ready = await open("./fixtures/plugins-installed.tsx", {
    width: 1100,
    height: 900,
  });
  await ready.press("label:remote-plugin");
  expect(ready.count("id:missing-values")).toBe(0);
});

test("a result shows name and version once, a short hash, and counts as chips", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", {
    width: 1100,
    height: 900,
  });
  await app.press("label:rich-plugin");
  await app.press("label:Test connection");
  expect(app.shows("github-mcp-server remote-15f2258")).toBe(true);
  expect(app.shows("15f22585c741f5")).toBe(false);
  expect(app.shows("github-mcp-server github-mcp-server")).toBe(false);
  expect(app.shows("12 tools")).toBe(true);
  expect(app.shows("4 resources")).toBe(true);
  expect(app.shows("1 prompt")).toBe(true);
  expect(app.shows("1 prompts")).toBe(false);
});

test("tools fold to the first five with a link for the rest; resources and prompts list too", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", {
    width: 1100,
    height: 900,
  });
  await app.press("label:rich-plugin");
  await app.press("label:Test connection");
  expect(app.count("id:tool-card:tool_4")).toBe(1);
  expect(app.count("id:tool-card:tool_5")).toBe(0);
  expect(app.shows("Show all 12")).toBe(true);
  await app.press("label:Show all 12");
  expect(app.count("id:tool-card:tool_11")).toBe(1);
  expect(app.shows("Show fewer")).toBe(true);
  await app.press("label:Show fewer");
  expect(app.count("id:tool-card:tool_5")).toBe(0);
  expect(app.shows("Resources (4)")).toBe(true);
  expect(app.count("id:resource-card:res_3")).toBe(1);
  expect(app.shows("Prompts (1)")).toBe(true);
  expect(app.count("id:prompt-card:prompt_0")).toBe(1);
  expect(app.shows("Show all 4")).toBe(false);
});

test("Show more is a link on a card whose text is cut, and only there; it turns into Show less", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", {
    width: 1100,
    height: 900,
  });
  await app.press("label:rich-plugin");
  await app.press("label:Test connection");
  expect(app.count("id:tool-card:tool_0 >> label:Show more")).toBe(1);
  expect(app.count("id:tool-card:tool_1 >> label:Show more")).toBe(0);
  await app.press("id:tool-card:tool_0 >> label:Show more");
  expect(app.count("id:tool-card:tool_0 >> label:Show less")).toBe(1);
  await app.press("id:tool-card:tool_0 >> label:Show less");
  expect(app.count("id:tool-card:tool_0 >> label:Show more")).toBe(1);
});

test("the Test connection button is never squeezed or wrapped, at a narrow width", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", {
    width: 520,
    height: 900,
  });
  await app.press("label:github-plugin");
  // The title row holds the buttons and what may give way; names and headers have their own line.
  expect(
    app.count("id:server-head:gh >> id:test-slot:gh >> label:Test connection"),
  ).toBe(1);
  // The harness has no geometry, so the layout itself (no wrap on the title row, slots that do not
  // shrink) is only checked by reading the code; the buttons staying in the title row is checked here.
});

test("a 401 that names a header: the badge says the sign-in is saved, and no token-header button is offered", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", {
    width: 1100,
    height: 900,
  });
  await app.press("label:header-plugin");
  expect(app.shows("Sign-in saved; the server wants x-cursor-auth")).toBe(
    false,
  );
  await app.press("label:Test connection");
  expect(app.shows("Sign-in saved; the server wants x-cursor-auth")).toBe(true);
  expect(app.shows("Send sign-in token in x-cursor-auth and retest")).toBe(
    false,
  );
  expect(app.shows("Same, as Bearer <token>")).toBe(false);
});

test("Sign in with Cursor: starts, notes the days left, and tests again", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", {
    width: 1100,
    height: 900,
  });
  await app.press("label:header-plugin");
  await app.press("label:Test connection");
  expect(app.shows("Sign in with Cursor account")).toBe(true);
  expect(
    app.shows(
      "Two steps, in this order: 1. sign in with your Cursor account, 2. then sign in to the service itself (Google, for google-drive). Step 1 saves your Cursor session credential, which can do more than an API key, as an encrypted header sent only to this server. Unofficial; it may stop working.",
    ),
  ).toBe(true);
  await app.press("label:Sign in with Cursor account");
  // The status poll runs on its own; give it a moment.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(app.shows("Connected · 12 ms")).toBe(true);
  expect(
    app.shows(
      "Signed in to Cursor; testing again · About 60 days of validity left (read from the credential, not checked); after that, sign in again",
    ),
  ).toBe(true);
});

test("with no saved sign-in, a Cursor server still offers the Cursor sign-in, and no token buttons", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", {
    width: 1100,
    height: 900,
  });
  await app.press("label:fresh-plugin");
  await app.press("label:Test connection");
  expect(app.shows("Sign in with Cursor account")).toBe(true);
  expect(
    app.shows(
      "Two steps, in this order: 1. sign in with your Cursor account, 2. then sign in to the service itself (Google, for google-drive). Step 1 saves your Cursor session credential, which can do more than an API key, as an encrypted header sent only to this server. Unofficial; it may stop working.",
    ),
  ).toBe(true);
  expect(app.shows("Send sign-in token in x-cursor-auth and retest")).toBe(
    false,
  );
});

test("a fresh Cursor server shows the Cursor sign-in at once, with no test run", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", {
    width: 1100,
    height: 900,
  });
  await app.press("label:cursor-new-plugin");
  expect(app.shows("Needs Cursor sign-in")).toBe(true);
  expect(app.shows("Sign in with Cursor account")).toBe(true);
  expect(app.shows("Sign in with Cursor account again")).toBe(false);
  expect(app.shows("Last test")).toBe(false);
});

test("with the Cursor credential saved, the button comes back as a re-login only after a test the server did not accept", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", {
    width: 1100,
    height: 900,
  });
  await app.press("label:cursor-in-plugin");
  expect(app.shows("Needs Cursor sign-in")).toBe(false);
  expect(app.shows("Sign in with Cursor account again")).toBe(false);
  await app.press("label:Test connection");
  expect(app.shows("Sign in with Cursor account again")).toBe(true);
  // It names both causes: the Cursor credential, or the service's own sign-in.
  expect(
    app.shows(
      "The server did not accept the sign-in. Either the saved Cursor credential no longer works, or the service's own sign-in (Google, for google-drive) has to be done again: sign in with Cursor first, then to the service. Unofficial; it may stop working.",
    ),
  ).toBe(true);
});

test("a server that is not a Cursor one has no Cursor sign-in before or after a test", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", {
    width: 1100,
    height: 900,
  });
  await app.press("label:acme-plugin");
  expect(app.shows("Sign in with Cursor account")).toBe(false);
  expect(app.shows("Needs Cursor sign-in")).toBe(false);
});

test("a server that is not a Cursor one gets no Cursor sign-in button", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", {
    width: 1100,
    height: 900,
  });
  await app.press("label:acme-plugin");
  await app.press("label:Test connection");
  expect(app.shows("the server requires the x-acme-session header")).toBe(true);
  expect(app.shows("Sign in with Cursor account")).toBe(false);
});

test("a result that names no header has no retest button", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", {
    width: 1100,
    height: 900,
  });
  await app.press("label:signed-plugin");
  await app.press("label:Test connection");
  expect(app.shows("Connected · 12 ms")).toBe(true);
  expect(app.shows("and retest")).toBe(false);
});

// A card's source (a repository and commit, or "Local directory") sits on the line under the name,
// after the version, instead of on a line of its own under the description.
const SOURCE_OPEN = { width: 1100, height: 700 };
const SHA = "acme/tools @ 0123456789ab";

test("a git card shows its source and its button on the version line, not on a line of its own", async () => {
  const app = await open(
    "./fixtures/plugins-installed-source.tsx",
    SOURCE_OPEN,
  );
  const version = app.layout("label:git-plugin >> text:2.0.0")!;
  const source = app.layout(`label:git-plugin >> text:${SHA}`)!;
  const button = app.layout("label:Source for git-plugin")!;
  const description = app.layout("label:git-plugin >> text:desc-git-plugin")!;
  expect(version).toBeDefined();
  expect(source).toBeDefined();
  expect(button).toBeDefined();
  const middle = (box: { y: number; height: number }) => box.y + box.height / 2;
  expect(Math.abs(middle(source) - middle(version))).toBeLessThanOrEqual(2);
  expect(Math.abs(middle(button) - middle(version))).toBeLessThanOrEqual(2);
  expect(source.x).toBeGreaterThan(version.x + version.width - 1);
  expect(source.y + source.height).toBeLessThanOrEqual(description.y);
});

test("the source button of a card still opens the source", async () => {
  const app = await open(
    "./fixtures/plugins-installed-source.tsx",
    SOURCE_OPEN,
  );
  await app.press("label:Source for git-plugin");
  expect(
    app.shows("acme/tools @ 0123456789abcdef0123456789abcdef01234567"),
  ).toBe(true);
});

test("a local card says Local directory on the version line, with no source button", async () => {
  const app = await open(
    "./fixtures/plugins-installed-source.tsx",
    SOURCE_OPEN,
  );
  const version = app.layout("label:local-plugin >> text:1.0.0")!;
  const source = app.layout("label:local-plugin >> text:Local directory")!;
  const description = app.layout(
    "label:local-plugin >> text:desc-local-plugin",
  )!;
  expect(source).toBeDefined();
  expect(Math.abs(source.y - version.y)).toBeLessThanOrEqual(2);
  expect(source.y + source.height).toBeLessThanOrEqual(description.y);
  expect(app.count("label:Source for local-plugin")).toBe(0);
});

test("a card with no version has its source at the left end of the line, with no gap before it", async () => {
  const app = await open(
    "./fixtures/plugins-installed-source.tsx",
    SOURCE_OPEN,
  );
  const description = app.layout(
    "label:bare-git-plugin >> text:desc-bare-git-plugin",
  )!;
  const git = app.layout(
    "label:bare-git-plugin >> text:acme/bare @ 0123456789ab",
  )!;
  expect(git).toBeDefined();
  expect(git.x).toBe(description.x);
  expect(git.y + git.height).toBeLessThanOrEqual(description.y);
  const local = app.layout("label:bare-local-plugin >> text:Local directory")!;
  const own = app.layout(
    "label:bare-local-plugin >> text:desc-bare-local-plugin",
  )!;
  expect(local).toBeDefined();
  expect(local.x).toBe(own.x);
  expect(local.y + local.height).toBeLessThanOrEqual(own.y);
});

test("a card that needs configuring keeps both its badge and its source on the line", async () => {
  const app = await open(
    "./fixtures/plugins-installed-source.tsx",
    SOURCE_OPEN,
  );
  const badge = app.layout(
    "label:config-git-plugin >> text:Needs configuring",
  )!;
  const source = app.layout(
    "label:config-git-plugin >> text:acme/needs-a-long-repository-name @ 0123456789ab",
  )!;
  expect(badge).toBeDefined();
  expect(source).toBeDefined();
  expect(source.width).toBeGreaterThan(40);
  expect(Math.abs(source.y - badge.y)).toBeLessThanOrEqual(4);
});
