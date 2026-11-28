import { expect, open, test } from "nsh/test";
import { palette } from "../src/components/theme";

const fixture = "./fixtures/routine-triggers.tsx";
const rgba = (hex: string) => `${hex.toLowerCase()}ff`;

test("list rows and details render event-only, event+schedule, fallbackReason, and error states", async () => {
  const app = await open(fixture, {
    platform: "macos",
    width: 1280,
    height: 820,
    locale: "en-US",
  });
  await app.waitFor("text:Commit Watcher");

  // Pure event-only routine shows trigger summary and listening state instead of "No upcoming run".
  expect(app.shows("text:composio / github / GITHUB_COMMIT_EVENT")).toBe(true);
  expect(app.shows("text:No upcoming run")).toBe(false);
  expect(app.shows("text:Active")).toBe(true);
  expect(app.shows("text:Last event 10 minutes ago")).toBe(true);

  // Event + schedule routine shows both schedule and trigger + fallbackReason.
  expect(app.shows("text:Daily at 09:00")).toBe(true);
  expect(app.shows("text:composio / github / GITHUB_RELEASE_EVENT")).toBe(true);
  expect(
    app.shows("text:Fallback: Webhook unsupported, fell back to polling"),
  ).toBe(true);

  // Errored trigger routine shows Error and lastError.
  expect(app.shows("text:Error")).toBe(true);
  expect(app.shows("text:Webhook registration failed (403)")).toBe(true);

  // Detail & Run history distinguish startedBy === "trigger" vs "user" vs "schedule".
  await app.press("label:Commit Watcher");
  await app.waitFor("text:Listening for external events");
  expect(
    app.shows(
      "text:owner=eta-dev, repo=eta, max_commits=5, branch_mode=default, include_bots=false",
    ),
  ).toBe(true);
  expect(app.shows("text:Event trigger")).toBe(true);
  expect(app.shows("text:Manual")).toBe(true);
  expect(app.shows("text:Scheduled")).toBe(true);

  // Open the trigger-started report to inspect its source badge.
  await app.press("label:Read report");
  await app.waitFor("text:Reviewed 3 commits pushed by @ada.");
  expect(app.shows("text:Event trigger")).toBe(true);
});

test("phone layout displays event routines and trigger details without blank nextRunAt", async () => {
  const app = await open(fixture, {
    platform: "ios",
    width: 390,
    height: 844,
    locale: "en-US",
  });
  await app.waitFor("text:Commit Watcher");
  expect(app.shows("text:No upcoming run")).toBe(false);
  expect(
    app.shows("text:Fallback: Webhook unsupported, fell back to polling"),
  ).toBe(true);

  await app.press("label:Broken Hook");
  await app.waitFor("text:Trigger error — check the trigger details above.");
  expect(app.shows("text:Webhook registration failed (403)")).toBe(true);
});

test("editor creates pure-event routine with multi-account, polling, and dynamic configSchema", async () => {
  const app = await open(fixture, {
    platform: "macos",
    width: 1280,
    height: 860,
    locale: "en-US",
  });
  await app.waitFor("label:New routine");
  await app.press("label:New routine");
  await app.waitFor("label:Event trigger");

  await app.type("label:Name", "Repo Push Monitor");
  await app.type("label:Brief", "Summarize incoming repo pushes.");
  await app.press("label:Event trigger");

  // Catalog loads; pick channel (Composio), then app (GitHub), then trigger (Commit Pushed).
  await app.waitFor("label:Channel");
  expect(app.shows("text:Refresh triggers")).toBe(true);
  await app.press("label:Refresh triggers");
  await app.waitFor('text:Triggers:{"refresh":true}');

  await app.press("label:Channel");
  await app.waitFor("label:Composio");
  await app.press("label:Composio");

  await app.waitFor("label:App / source");
  await app.press("label:App / source");
  await app.waitFor("label:GitHub");
  await app.press("label:GitHub");
  await app.press("label:Trigger event");
  await app.waitFor("label:Commit Pushed");
  await app.press("label:Commit Pushed");

  // Deprecated field without saved value is skipped; schema fields render with defaults.
  await app.waitFor("label:Owner");
  expect(app.shows("label:Legacy secret")).toBe(false);
  expect(app.shows("text:Choose a connected account.")).toBe(true);

  // Pick one of the multiple connected accounts.
  await app.press("label:Account");
  await app.waitFor("label:Personal GitHub (ca_personal)");
  await app.press("label:Personal GitHub (ca_personal)");

  // Switch delivery mode to Polling, verify validation, then verify switching back to Webhook clears polling.
  await app.press("label:Delivery mode");
  await app.waitFor("label:Polling");
  await app.press("label:Polling");
  await app.waitFor("label:Polling interval (minutes)");
  await app.type("label:Polling interval (minutes)", "0");
  expect(app.shows("text:Enter a whole number between 1 and 10080.")).toBe(
    true,
  );
  await app.press("label:Delivery mode");
  await app.waitFor("label:Webhook (real-time)");
  await app.press("label:Webhook (real-time)");
  expect(app.shows("label:Polling interval (minutes)")).toBe(false);

  // Switch back to Polling with a valid interval and verify refresh preserves edited draft fields.
  await app.press("label:Delivery mode");
  await app.waitFor("label:Polling");
  await app.press("label:Polling");
  await app.waitFor("label:Polling interval (minutes)");
  await app.type("label:Polling interval (minutes)", "15");

  // Validate integer field & fill required fields.
  await app.clear("label:Max commits");
  await app.type("label:Max commits", "0");
  expect(app.shows("text:Minimum 1")).toBe(true);
  await app.clear("label:Max commits");
  await app.type("label:Max commits", "20");

  await app.press("label:Refresh triggers");
  await app.waitFor("label:Max commits");
  expect(app.value("label:Max commits")).toBe("20");

  await app.type("label:Owner", "acme");
  await app.type("label:Repository", "web");

  await app.press("label:Create");
  await app.waitFor("text:Repo Push Monitor");

  const createLine = app.texts().find((t) => t.startsWith("Create:")) ?? "";
  const payload = JSON.parse(createLine.slice("Create:".length)) as {
    schedule: unknown;
    trigger: {
      provider: string;
      source: string;
      trigger: string;
      accountId: string;
      mode: string;
      pollingIntervalMinutes: number;
      config: Record<string, unknown>;
    };
  };
  expect(payload.schedule).toBeNull();
  expect(payload.trigger).toEqual({
    provider: "composio",
    source: "github",
    trigger: "GITHUB_COMMIT_EVENT",
    accountId: "ca_personal",
    mode: "poll",
    pollingIntervalMinutes: 15,
    config: {
      owner: "acme",
      repo: "web",
      max_commits: 20,
      branch_mode: "all",
      include_bots: true,
    },
  });
});

test("editor creates event + schedule routine and edits/clears existing trigger", async () => {
  const app = await open(fixture, {
    platform: "macos",
    width: 1280,
    height: 860,
    locale: "en-US",
  });

  // Edit existing event routine -> pre-fills trigger & config, then clear to Schedule only.
  await app.press("label:Commit Watcher");
  await app.waitFor("label:Routine actions");
  await app.press("label:Routine actions");
  await app.press("label:Edit");
  await app.waitFor("label:Owner");
  expect(app.value("label:Owner")).toBe("eta-dev");
  expect(app.value("label:Repository")).toBe("eta");

  // Switch to Event + schedule and save with both schedule and trigger.
  await app.press("label:Event + schedule");
  await app.press("label:Save");
  await app.waitUntil(() => app.texts().some((t) => t.startsWith("Update:")));
  const bothLine = app.texts().find((t) => t.startsWith("Update:")) ?? "";
  const bothPayload = JSON.parse(bothLine.slice("Update:".length)) as {
    schedule: { kind: string };
    trigger: { trigger: string };
  };
  expect(bothPayload.schedule).not.toBeNull();
  expect(bothPayload.trigger.trigger).toBe("GITHUB_COMMIT_EVENT");

  // Re-open edit and switch to Schedule only -> sends trigger: null.
  await app.press("label:Routine actions");
  await app.press("label:Edit");
  await app.waitFor("label:Schedule only");
  await app.press("label:Schedule only");
  await app.press("label:Save");
  await app.waitUntil(() =>
    (app.texts().find((t) => t.startsWith("Update:")) ?? "").includes(
      '"trigger":null',
    ),
  );
});

test("editor renders provider status errors and empty state with Plugins guidance", async () => {
  const app = await open(fixture, {
    platform: "macos",
    width: 1280,
    height: 860,
    locale: "en-US",
  });

  await app.press("label:Scenario: needs_key");
  await app.press("label:New routine");
  await app.press("label:Event trigger");
  await app.waitFor("text:Composio needs an API key");
  await app.press("label:Open Plugin settings");
  await app.waitFor("text:Nav:plugin-settings");

  await app.press("label:Scenario: key_rejected");
  await app.press("label:Refresh triggers");
  await app.waitFor("text:Composio rejected the API key");
  expect(app.shows("text:Invalid Composio API key")).toBe(true);

  await app.press("label:Scenario: disabled");
  await app.press("label:Refresh triggers");
  await app.waitFor("text:Composio is turned off");

  await app.press("label:Scenario: error");
  await app.press("label:Refresh triggers");
  await app.waitFor("text:Webhook trigger service error");
  expect(app.shows("text:Trigger service unreachable")).toBe(true);

  await app.press("label:Scenario: empty");
  await app.press("label:Refresh triggers");
  await app.waitFor("text:No event triggers available");
  await app.press("label:Open Plugins");
  await app.waitFor("text:Nav:plugin-settings,plugins");

  await app.press("label:Scenario: partial_empty");
  await app.press("label:Refresh triggers");
  await app.waitFor("label:Channel");
  await app.press("label:Channel");
  await app.waitFor("label:Composio");
  await app.press("label:Composio");
  await app.waitFor("text:No event triggers available");
});

test("Captain create_routine proposal cards show schedule, trigger, and scheduleText for all 3 modes", async () => {
  const app = await open(fixture, {
    platform: "macos",
    width: 1280,
    height: 860,
    locale: "en-US",
  });
  await app.press("label:View: proposals");
  await app.waitFor("text:Morning Brief");

  // Schedule-only proposal
  expect(app.shows("text:every day at 09:00")).toBe(true);
  expect(app.texts().some((t) => t.includes("Daily at 09:00"))).toBe(true);

  // Trigger-only proposal
  expect(app.shows("text:PR Watcher")).toBe(true);
  expect(app.shows("text:on composio/github: GITHUB_COMMIT_EVENT")).toBe(true);
  expect(
    app.shows(
      "text:composio / github / GITHUB_COMMIT_EVENT · webhook · owner=eta-dev, repo=eta",
    ),
  ).toBe(true);
  expect(app.shows("text:Asia/Shanghai")).toBe(true);

  // Schedule + trigger proposal
  expect(app.shows("text:Release Sweep")).toBe(true);
  expect(
    app.shows(
      "text:every day at 20:00 + composio/github: GITHUB_RELEASE_EVENT",
    ),
  ).toBe(true);
  expect(
    app.shows("text:composio / github / GITHUB_RELEASE_EVENT · poll · 15m"),
  ).toBe(true);
});

test("single-option channel (RSS) auto-selects trigger, folds redundant selects, and shows 15m polling placeholder", async () => {
  const app = await open(fixture, {
    platform: "macos",
    width: 1280,
    height: 860,
    locale: "en-US",
  });
  await app.waitFor("label:New routine");
  await app.press("label:New routine");
  await app.waitFor("label:Event trigger");

  await app.type("label:Name", "Release Blog Feed");
  await app.type("label:Brief", "Summarize new feed posts.");
  await app.press("label:Event trigger");

  await app.waitFor("label:Channel");
  await app.press("label:Channel");
  await app.waitFor("label:RSS");
  await app.press("label:RSS");

  // Single source + single trigger are auto-selected and their redundant selectors stay hidden.
  await app.waitFor("text:New feed item");
  expect(app.shows("text:RSS_NEW_ITEM")).toBe(true);
  expect(app.shows("label:App / source")).toBe(false);
  expect(app.shows("label:Trigger event")).toBe(false);

  // Feed URL, keywords, and polling interval (default placeholder "15") render directly.
  await app.waitFor("label:Feed URL");
  expect(app.shows("label:Include keywords")).toBe(true);
  expect(app.shows("label:Exclude keywords")).toBe(true);
  expect(app.shows("label:Polling interval (minutes)")).toBe(true);
  expect(app.shows("text:15")).toBe(true);
  expect(app.layout("text:15")).toEqual(
    app.layout("label:Polling interval (minutes)"),
  );

  await app.type("label:Feed URL", "https://example.com/feed.xml");
  await app.press("label:Create");
  await app.waitFor("text:Release Blog Feed");

  const createLine = app.texts().find((t) => t.startsWith("Create:")) ?? "";
  const payload = JSON.parse(createLine.slice("Create:".length)) as {
    trigger: {
      provider: string;
      source: string;
      trigger: string;
      mode: string;
      pollingIntervalMinutes: number | null;
      config: Record<string, unknown>;
    };
  };
  expect(payload.trigger).toEqual({
    provider: "rss",
    source: "feed",
    trigger: "RSS_NEW_ITEM",
    accountId: null,
    mode: "poll",
    pollingIntervalMinutes: null,
    config: { url: "https://example.com/feed.xml" },
  });
});

test("multi-option selects stay visible, TriggerSearchSelect highlights on hover, and stale edit keeps fallback selects", async () => {
  const c = palette("light", "default");
  const app = await open(fixture, {
    platform: "macos",
    width: 1280,
    height: 860,
    locale: "en-US",
  });
  await app.waitFor("label:New routine");
  await app.press("label:New routine");
  await app.waitFor("label:Event trigger");
  await app.press("label:Event trigger");

  await app.waitFor("label:Channel");
  await app.press("label:Channel");
  await app.waitFor("label:Composio");
  await app.press("label:Composio");

  // Multi-source provider shows App / source; hovering an item highlights it.
  await app.waitFor("label:App / source");
  await app.press("label:App / source");
  await app.waitFor("id:trigger-search-item-slack");
  expect(
    app.viewStyle("id:trigger-search-item-slack")?.backgroundColor ?? null,
  ).toBeNull();
  await app.hover("id:trigger-search-item-slack");
  expect(app.viewStyle("id:trigger-search-item-slack")?.backgroundColor).toBe(
    rgba(c.selected),
  );

  // Selecting single-trigger source (Slack) auto-selects its trigger and hides Trigger event.
  await app.press("label:Slack");
  await app.waitFor("text:New Slack message");
  expect(app.shows("label:App / source")).toBe(true);
  expect(app.shows("label:Trigger event")).toBe(false);
  expect(app.shows("label:Slack channel")).toBe(true);

  // Switching to multi-trigger source (GitHub) shows Trigger event, hovers items, and uses "5" placeholder.
  await app.press("label:App / source");
  await app.waitFor("label:GitHub");
  await app.press("label:GitHub");
  await app.waitFor("label:Trigger event");
  await app.press("label:Trigger event");
  await app.waitFor("id:trigger-search-item-GITHUB_RELEASE_EVENT");
  expect(
    app.viewStyle("id:trigger-search-item-GITHUB_RELEASE_EVENT")
      ?.backgroundColor ?? null,
  ).toBeNull();
  await app.hover("id:trigger-search-item-GITHUB_RELEASE_EVENT");
  expect(
    app.viewStyle("id:trigger-search-item-GITHUB_RELEASE_EVENT")
      ?.backgroundColor,
  ).toBe(rgba(c.selected));
  await app.press("label:Release Published");
  await app.waitFor("label:Polling interval (minutes)");
  expect(app.shows("text:5")).toBe(true);
  expect(app.layout("text:5")).toEqual(
    app.layout("label:Polling interval (minutes)"),
  );
  await app.press("label:Cancel");

  // Editing an existing routine whose saved source/trigger is absent from current catalog keeps fallback selects.
  await app.press("label:Scenario: stale_catalog");
  await app.press("label:Commit Watcher");
  await app.waitFor("label:Routine actions");
  await app.press("label:Routine actions");
  await app.press("label:Edit");
  await app.waitFor(
    "text:This trigger is not in the current catalog; saved settings are kept.",
  );
  expect(app.shows("label:App / source")).toBe(true);
  expect(app.shows("label:Trigger event")).toBe(true);
});

test("Webhook channel auto-folds single source/trigger and detail panel supports copy URL/curl, secret reveal/set, and rotate", async () => {
  const app = await open(fixture, {
    platform: "macos",
    width: 1280,
    height: 860,
    locale: "en-US",
  });
  await app.waitFor("label:New routine");
  await app.press("label:New routine");
  await app.waitFor("label:Event trigger");

  await app.type("label:Name", "Deploy Hook");
  await app.type("label:Brief", "Summarize incoming deploy webhooks.");
  await app.press("label:Event trigger");

  await app.waitFor("label:Channel");
  await app.press("label:Channel");
  await app.waitFor("label:Webhook");
  await app.press("label:Webhook");

  // Single source + single trigger auto-selected and selectors folded.
  await app.waitFor("text:Webhook received");
  expect(app.shows("text:WEBHOOK_RECEIVED")).toBe(true);
  expect(app.shows("label:App / source")).toBe(false);
  expect(app.shows("label:Trigger event")).toBe(false);
  expect(app.shows("label:Polling interval (minutes)")).toBe(false);

  // Choose HMAC-SHA256 authentication mode.
  await app.waitFor("label:Authentication");
  await app.press("label:Authentication");
  await app.waitFor("label:HMAC-SHA256 signature");
  await app.press("label:HMAC-SHA256 signature");

  await app.press("label:Create");
  await app.waitFor("text:Deploy Hook");

  // Detail panel renders inbound URL, loopback hint, copy URL/curl, masked secret, and rotate.
  await app.waitFor("text:http://127.0.0.1:4100/hooks/tok_1");
  expect(app.shows("text:HMAC-SHA256 · X-Hub-Signature-256")).toBe(true);
  expect(
    app.shows(
      "text:This URL uses a local loopback address. External services need a public URL, Tailscale, or a reverse proxy to reach it.",
    ),
  ).toBe(true);
  expect(app.shows("text:sec_initial_1")).toBe(false);

  await app.press("label:Copy URL");
  await app.waitUntil(
    () => app.clipboard() === "http://127.0.0.1:4100/hooks/tok_1",
  );

  await app.press("label:Copy curl");
  await app.waitUntil(() =>
    (app.clipboard() ?? "").includes(
      "curl -X POST 'http://127.0.0.1:4100/hooks/tok_1' -H 'Content-Type: application/json' -H 'X-Hub-Signature-256: sha256=<hmac-sha256>'",
    ),
  );

  // Reveal secret & set a custom secret.
  await app.press("label:Show");
  await app.waitFor("text:sec_initial_1");
  await app.press("label:Copy secret");
  await app.waitUntil(() => app.clipboard() === "sec_initial_1");

  await app.type("label:Custom secret", "gh_secret_custom");
  await app.press("label:Save");
  await app.waitFor("text:gh_secret_custom");
  expect(
    app.shows("text:WebhookAction:setSecret:r-created:gh_secret_custom"),
  ).toBe(true);

  // Rotate credentials with confirmation dialog.
  await app.press("label:Rotate credentials");
  await app.waitFor("text:Rotate webhook credentials?");
  await app.press("label:Rotate");
  await app.waitFor("text:http://127.0.0.1:4100/hooks/tok_rot_2");
  expect(app.shows("text:WebhookAction:rotate:r-created")).toBe(true);
});

test("Web Monitor channel auto-folds selects, validates selector vs jsonPath conflict, and renders lastCheckedAt/lastEventAt/lastError", async () => {
  const app = await open(fixture, {
    platform: "macos",
    width: 1280,
    height: 860,
    locale: "en-US",
  });

  // Detail panel shows lastCheckedAt, lastEventAt (last changed), and lastError for web-monitor.
  await app.waitFor("label:Pricing Page Watch");
  await app.press("label:Pricing Page Watch");
  await app.waitFor("text:web-monitor / http / WEB_CONTENT_CHANGED");
  expect(app.texts().some((text) => text.startsWith("Last checked · "))).toBe(
    true,
  );
  expect(app.texts().some((text) => text.startsWith("Last changed · "))).toBe(
    true,
  );
  expect(app.shows('text:CSS selector ".plan-price" matched no elements')).toBe(
    true,
  );

  // Create a new Web Monitor routine via editor.
  await app.press("label:New routine");
  await app.waitFor("label:Event trigger");

  await app.type("label:Name", "API Release Monitor");
  await app.type("label:Brief", "Notify when release version changes.");
  await app.press("label:Event trigger");

  await app.waitFor("label:Channel");
  await app.press("label:Channel");
  await app.waitFor("label:Web Monitor");
  await app.press("label:Web Monitor");

  await app.waitFor("text:Web / JSON content changed");
  expect(app.shows("text:WEB_CONTENT_CHANGED")).toBe(true);
  expect(app.shows("label:App / source")).toBe(false);
  expect(app.shows("label:Trigger event")).toBe(false);
  expect(app.shows("label:Polling interval (minutes)")).toBe(true);
  expect(app.shows("text:15")).toBe(true);

  await app.type("label:URL", "https://api.example.com/version");
  await app.type("label:CSS selector", ".version");
  await app.type("label:JSON path", "$.version");
  expect(
    app.shows("text:Specify either CSS selector or JSON path, not both."),
  ).toBe(true);

  await app.clear("label:CSS selector");
  await app.type("label:Polling interval (minutes)", "10");
  await app.press("label:Create");
  await app.waitFor("text:API Release Monitor");

  const createLine = app.texts().find((t) => t.startsWith("Create:")) ?? "";
  const payload = JSON.parse(createLine.slice("Create:".length)) as {
    trigger: {
      provider: string;
      source: string;
      trigger: string;
      mode: string;
      pollingIntervalMinutes: number | null;
      config: Record<string, unknown>;
    };
  };
  expect(payload.trigger).toEqual({
    provider: "web-monitor",
    source: "http",
    trigger: "WEB_CONTENT_CHANGED",
    accountId: null,
    mode: "poll",
    pollingIntervalMinutes: 10,
    config: {
      url: "https://api.example.com/version",
      jsonPath: "$.version",
      method: "GET",
    },
  });
});
