import { expect, open, test } from "nsh/test";

// A group's system rows say what happened in the reader's language, naming agents as they are
// called now; an event the client does not know keeps the host's words; Captain's proposal stays a
// card. How a notice looks is shown in the PR with a real browser.

const fixture = "./fixtures/system-notices.tsx";

const english = [
  "Ada is now the steward.",
  "Bob is now the steward, taking over from Ada.",
  "Bob left the group; it has no steward now.",
  "Cy is no longer the steward.",
  "This message has used its 5 wake-ups; later @mentions stay in the conversation and wake nobody until you write again.",
  "Created by Captain",
  "Routine “Weekly digest” sent a report: Five launches",
];

const chinese = [
  "Ada 成为主理人。",
  "Bob 成为主理人，接替 Ada。",
  "Bob 退出了群，现在没有主理人。",
  "Cy 不再是主理人。",
  "这条消息已经用完 5 次唤醒；之后的 @ 只记入对话，等你再发言才会唤醒。",
  "由 Captain 创建",
  "定时任务「Weekly digest」发来汇报：Five launches",
];

const unknown = "The launch checklist was archived by the host.";

for (const [locale, lines] of [
  ["en-US", english],
  ["zh-CN", chinese],
] as const)
  test(`each event reads in the reader's language (${locale})`, async () => {
    const app = await open(fixture, { width: 1440, height: 1400, locale });
    for (const line of lines) expect(app.shows(`text:${line}`)).toBe(true);
    expect(app.shows(`text:${unknown}`)).toBe(true);
    // The host's English for a known event is not what the reader sees.
    expect(app.shows("text:Created by Captain.")).toBe(false);
  });

test("a renamed agent's notices use its new name", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 1400,
    locale: "en-US",
  });
  await app.press("Rename Bob");
  expect(app.shows("text:Bea is now the steward, taking over from Ada.")).toBe(
    true,
  );
  expect(app.shows("text:Bea left the group; it has no steward now.")).toBe(
    true,
  );
});

test("Captain's proposal stays a card, not a notice", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 1400,
    locale: "en-US",
  });
  expect(app.shows("text:Docs revamp")).toBe(true);
  expect(app.shows("text:Create")).toBe(true);
  expect(app.shows("text:Reject")).toBe(true);
  expect(
    app.shows(
      'text:Captain proposed the group "Docs revamp". It is made when the user confirms it.',
    ),
  ).toBe(false);
});
