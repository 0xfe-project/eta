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

test("File Watch channel auto-folds selects, validates path/glob, and renders watchedCount/lastEventAt/lastError", async () => {
  const app = await open(fixture, {
    platform: "macos",
    width: 1280,
    height: 860,
    locale: "en-US",
  });

  // Detail panel shows watched paths count, lastEventAt, and lastError for file-watch.
  await app.waitFor("label:Local Docs Watch");
  await app.press("label:Local Docs Watch");
  await app.waitFor("text:file-watch / fs / FILE_CHANGED");
  expect(app.shows("text:Watching 12 paths")).toBe(true);
  expect(app.texts().some((text) => text.startsWith("Last event · "))).toBe(
    true,
  );
  expect(app.shows("text:Watched file count exceeds limit (5000)")).toBe(true);

  // Create a new File Watch routine via editor.
  await app.press("label:New routine");
  await app.waitFor("label:Event trigger");

  await app.type("label:Name", "Reports Folder Watch");
  await app.type("label:Brief", "Summarize newly added reports.");
  await app.press("label:Event trigger");

  await app.waitFor("label:Channel");
  await app.press("label:Channel");
  await app.waitFor("label:File Watch");
  await app.press("label:File Watch");

  await app.waitFor("text:File or directory changed");
  expect(app.shows("text:FILE_CHANGED")).toBe(true);
  expect(app.shows("label:App / source")).toBe(false);
  expect(app.shows("label:Trigger event")).toBe(false);
  expect(app.shows("label:Fallback scan interval (minutes)")).toBe(true);
  expect(app.value("label:Debounce (ms)")).toBe("500");

  // Validate relative path and drive root errors before entering a valid path.
  await app.type("label:Watch path", "relative/folder");
  expect(
    app.shows(
      "text:Enter an absolute path or start with ~ (e.g. ~/Documents).",
    ),
  ).toBe(true);
  await app.clear("label:Watch path");
  await app.type("label:Watch path", "/");
  expect(
    app.shows("text:Cannot watch an entire drive or filesystem root."),
  ).toBe(true);
  await app.clear("label:Watch path");
  await app.type("label:Watch path", "~/Documents/reports");

  await app.type("label:Include glob", "**/*.md");
  await app.type("label:Ignore glob", "*.tmp");
  await app.clear("label:Debounce (ms)");
  await app.type("label:Debounce (ms)", "250");
  await app.type("label:Fallback scan interval (minutes)", "10");

  await app.press("label:Create");
  await app.waitFor("text:Reports Folder Watch");

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
    provider: "file-watch",
    source: "fs",
    trigger: "FILE_CHANGED",
    accountId: null,
    mode: "poll",
    pollingIntervalMinutes: 10,
    config: {
      path: "~/Documents/reports",
      glob: "**/*.md",
      ignore: "*.tmp",
      debounceMs: 250,
    },
  });
});

test("Eta Events channel folds single source, lets user pick event & status/assignee filters, and renders event name, lastEventAt, and lastError", async () => {
  const c = palette("light", "default");
  const app = await open(fixture, {
    platform: "macos",
    width: 1280,
    height: 860,
    locale: "en-US",
  });

  // Detail panel shows event name, lastEventAt, and lastError for eta-events.
  await app.waitFor("label:Review Notification");
  await app.press("label:Review Notification");
  await app.waitFor("text:eta-events / tasks / task.status.changed");
  expect(app.texts().some((text) => text.startsWith("Last event · "))).toBe(
    true,
  );
  expect(app.shows("text:Unsupported eta-events filter")).toBe(true);

  // Create a new Eta Events routine via editor.
  await app.press("label:New routine");
  await app.waitFor("label:Event trigger");

  await app.type("label:Name", "Blocked & Review Digest");
  await app.type(
    "label:Brief",
    "Notify when Forge tasks enter review or blocked.",
  );
  await app.press("label:Event trigger");

  await app.waitFor("label:Channel");
  await app.press("label:Channel");
  await app.waitFor("label:Eta Events");
  await app.press("label:Eta Events");

  // Single source ("tasks") auto-folds; Trigger event remains visible for multi-event selection.
  await app.waitFor("label:Trigger event");
  expect(app.shows("label:App / source")).toBe(false);
  expect(app.shows("label:Polling interval (minutes)")).toBe(false);
  expect(app.shows("label:Delivery mode")).toBe(false);

  await app.press("label:Trigger event");
  await app.waitFor("label:Task run finished");
  await app.press("label:Task status changed");

  await app.waitFor("text:task.status.changed");
  await app.waitFor("label:Target statuses: in_review");

  // Hover and selected background highlight match, with no cursor: pointer.
  await app.hover("label:Target statuses: in_review");
  expect(
    app.viewStyle("label:Target statuses: in_review")?.backgroundColor,
  ).toBe(rgba(c.selected));
  expect(
    Object.hasOwn(
      app.viewStyle("label:Target statuses: in_review") ?? {},
      "cursor",
    ),
  ).toBe(false);

  await app.press("label:Target statuses: in_review");
  expect(
    app.viewStyle("label:Target statuses: in_review")?.backgroundColor,
  ).toBe(rgba(c.selected));
  await app.press("label:Target statuses: blocked");
  await app.press("label:Previous statuses: in_progress");
  await app.type("label:Assignee", "forge");

  await app.press("label:Create");
  await app.waitFor("text:Blocked & Review Digest");

  const createLine = app.texts().find((t) => t.startsWith("Create:")) ?? "";
  const payload = JSON.parse(createLine.slice("Create:".length)) as {
    trigger: {
      provider: string;
      source: string;
      trigger: string;
      accountId: string | null;
      mode: string | null;
      pollingIntervalMinutes: number | null;
      config: Record<string, unknown>;
    };
  };
  expect(payload.trigger).toEqual({
    provider: "eta-events",
    source: "tasks",
    trigger: "task.status.changed",
    accountId: null,
    mode: null,
    pollingIntervalMinutes: null,
    config: {
      to: ["in_review", "blocked"],
      from: ["in_progress"],
      assignee: "forge",
    },
  });
});

async function openZhEditor() {
  const app = await open(fixture, {
    platform: "macos",
    width: 1280,
    height: 860,
    locale: "zh-CN",
  });
  await app.waitFor("label:新建定时任务");
  await app.press("label:Scenario: ready");
  await app.press("label:新建定时任务");
  await app.waitFor("label:仅事件触发");
  await app.type("label:名称", "触发器翻译");
  await app.type("label:要求", "检查触发器中文。");
  await app.press("label:仅事件触发");
  await app.waitFor("label:渠道");
  return app;
}

test("built-in provider catalogs and config fields show in Chinese", async () => {
  const app = await openZhEditor();

  async function choose(provider: string) {
    await app.press("label:渠道");
    await app.waitFor(`label:${provider}`);
    await app.press(`label:${provider}`);
  }

  await choose("Webhook");
  await app.waitFor("text:收到 Webhook");
  for (const title of ["验证方式", "请求头名称", "包含关键词", "排除关键词"]) {
    expect(app.shows(`label:${title}`)).toBe(true);
  }
  expect(app.shows("label:Authentication")).toBe(false);
  await app.press("label:验证方式");
  await app.waitFor("label:HMAC-SHA256 签名");
  expect(app.shows("label:共享密钥请求头")).toBe(true);
  expect(app.shows("label:仅地址令牌（无）")).toBe(true);
  await app.press("label:HMAC-SHA256 签名");

  await choose("RSS");
  await app.waitFor("text:新订阅条目");
  expect(
    app.shows(
      "text:RSS 2.0、Atom 1.0 或 JSON Feed 1.1 订阅源发布新条目时触发。",
    ),
  ).toBe(true);
  expect(app.shows("label:订阅地址")).toBe(true);
  expect(
    app.shows("text:RSS 2.0、Atom 1.0 或 JSON Feed 1.1 的地址（http/https）。"),
  ).toBe(true);
  expect(app.shows("label:包含关键词")).toBe(true);
  expect(app.shows("label:排除关键词")).toBe(true);

  await choose("网页监控");
  await app.waitFor("text:网页 / JSON 内容变化");
  for (const title of [
    "地址",
    "CSS 选择器",
    "JSON 路径",
    "HTTP 方法",
    "请求头",
  ]) {
    expect(app.shows(`label:${title}`)).toBe(true);
  }
  expect(app.shows("text:要监控的 HTTP 或 HTTPS 地址。")).toBe(true);

  await choose("文件监听");
  await app.waitFor("text:文件或目录变化");
  for (const title of [
    "监听路径",
    "包含的 glob",
    "忽略的 glob",
    "防抖（毫秒）",
  ]) {
    expect(app.shows(`label:${title}`)).toBe(true);
  }
  expect(
    app.shows("text:本机文件或目录的绝对路径，或 ~/... 形式的路径。"),
  ).toBe(true);
});

test("eta-events fields show in Chinese while group, creator and assignee options keep the host's names", async () => {
  const app = await open(fixture, {
    platform: "macos",
    width: 1280,
    height: 860,
    locale: "zh-CN",
  });
  await app.waitFor("label:新建定时任务");
  await app.press("label:Scenario: origin_filters");
  await app.press("label:新建定时任务");
  await app.waitFor("label:仅事件触发");
  await app.type("label:名称", "任务事件");
  await app.type("label:要求", "检查任务事件。");
  await app.press("label:仅事件触发");
  await app.waitFor("label:渠道");
  await app.press("label:渠道");
  await app.waitFor("label:eta 事件");
  await app.press("label:eta 事件");

  await app.waitFor("label:触发器类型");
  await app.press("label:触发器类型");
  await app.waitFor("label:任务运行结束");
  expect(
    app.shows("text:任务状态变化时触发（例如进入待验收、已完成或已阻塞）。"),
  ).toBe(true);
  await app.press("label:任务状态变化");

  await app.waitFor("label:目标状态: 待验收");
  expect(app.shows("label:目标状态: 已阻塞")).toBe(true);
  expect(app.shows("label:原状态: 进行中")).toBe(true);
  expect(app.shows("label:目标状态: in_review")).toBe(false);
  expect(
    app.shows("text:可选，要匹配的目标状态（留空则匹配任何状态变化）。"),
  ).toBe(true);
  expect(
    app.shows(
      "text:可选，任务是在哪个群聊里提出的，包括 Captain 的对话（留空则不限）。",
    ),
  ).toBe(true);

  await app.press("label:来源群聊");
  await app.waitFor("label:Dev Group");
  expect(app.shows("label:Release Crew")).toBe(true);
  await app.press("label:Release Crew");

  await app.press("label:创建者");
  await app.waitFor("label:Forge");
  expect(app.shows("label:Ada")).toBe(true);
  await app.press("label:Ada");

  await app.press("label:执行者");
  await app.waitFor("label:Forge");
  await app.press("label:Forge");

  await app.press("label:创建");
  await app.waitFor("text:任务事件");
  const createLine = app.texts().find((t) => t.startsWith("Create:")) ?? "";
  const payload = JSON.parse(createLine.slice("Create:".length)) as {
    trigger: { config: Record<string, unknown> };
  };
  expect(payload.trigger.config).toEqual({
    group: "g2",
    creator: "a2",
    assignee: "a1",
  });
});

test("eta-events fields keep the host's English text in English", async () => {
  const app = await open(fixture, {
    platform: "macos",
    width: 1280,
    height: 860,
    locale: "en-US",
  });
  await app.waitFor("label:New routine");
  await app.press("label:Scenario: origin_filters");
  await app.press("label:New routine");
  await app.waitFor("label:Event trigger");
  await app.type("label:Name", "Task events");
  await app.type("label:Brief", "Check task events.");
  await app.press("label:Event trigger");
  await app.waitFor("label:Channel");
  await app.press("label:Channel");
  await app.waitFor("label:Eta Events");
  await app.press("label:Eta Events");
  await app.waitFor("label:Trigger event");
  await app.press("label:Trigger event");
  await app.waitFor("label:Task run finished");
  await app.press("label:Task status changed");

  await app.waitFor("label:Target statuses: in_review");
  expect(app.shows("label:Previous statuses: in_progress")).toBe(true);
  for (const title of ["Source group", "Creator", "Assignee"]) {
    expect(app.shows(`label:${title}`)).toBe(true);
  }
  await app.press("label:Source group");
  await app.waitFor("label:Dev Group");
  expect(app.shows("label:Release Crew")).toBe(true);
});
