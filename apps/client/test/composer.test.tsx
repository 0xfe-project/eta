import { expect, open, test } from "nsh/test";

const input = "role:combobox";
const fixture = (width = 720) =>
  open("./composer-fixture.tsx", {
    platform: "macos",
    width,
    height: 600,
    clock: { time: 1000 },
  });

test("a draft returns to its own chat and a failed delivery can be retried with the same id", async () => {
  const app = await fixture();
  await app.type(input, "retry");
  await app.press("label:Switch");
  expect(app.value(input)).toBe("");
  await app.type(input, "elsewhere");
  await app.press("label:Switch");
  expect(app.value(input)).toBe("retry");
  await app.submit(input);
  await app.waitFor("label:Retry");
  expect(app.value(input)).toBe("");
  await app.press("label:Switch");
  expect(app.value(input)).toBe("elsewhere");
  await app.press("label:Switch");
  await app.press("label:Retry");
  await app.waitFor('text:sent ["alpha","retry","queue",[]]');
  expect(app.value(input)).toBe("");
});

test("IME confirmation cannot send or accept a completion; Tab accepts the highlighted row", async () => {
  const app = await fixture();
  await app.type(input, "询问，@");
  await app.compose(input, "a");
  await app.submit(input);
  expect(app.value(input)).toBe("询问，@");
  await app.compose(input, "");
  await app.submit(input);
  expect(app.value(input)).toBe("询问，@");
  await app.wait(150);
  await app.keyboard.press("down");
  await app.keyboard.press("tab");
  expect(app.value(input)).toBe("询问，@README.md ");
});

test("Escape dismisses completion first and only an empty draft can stop the running replies", async () => {
  const app = await fixture();
  await app.type(input, "@");
  await app.keyboard.press("escape");
  expect(app.shows("role:listbox")).toBe(false);
  await app.keyboard.press("escape");
  expect(app.shows("text:stopped alpha")).toBe(false);
  await app.keyboard.press("backspace");
  await app.keyboard.press("escape");
  await app.waitFor("text:stopped alpha");
});

test("pasted files stay attached to their chat and rich clipboard text wins over its preview image", async () => {
  const app = await fixture();
  await app.paste(input, { files: ["test/composer-fixture.tsx"] });
  await app.waitFor("label:composer-fixture.tsx");
  await app.press("label:Switch");
  expect(app.shows("label:composer-fixture.tsx")).toBe(false);
  await app.press("label:Switch");
  await app.waitFor("label:composer-fixture.tsx");
  await app.paste(input, {
    text: "office text",
    html: "<b>office text</b>",
    files: ["assets/onboard.jpg"],
  });
  expect(app.value(input)).toBe("office text");
  expect(app.shows("text:upload interrupted")).toBe(false);
  expect(app.shows("label:onboard.jpg")).toBe(false);
});

test("a failed send can be edited above a new draft or discarded on its own", async () => {
  const app = await fixture();
  await app.type(input, "retry");
  await app.submit(input);
  await app.waitFor("label:Edit");
  await app.type(input, "later");
  await app.press("label:Edit");
  expect(app.value(input)).toBe("retry\nlater");
  await app.press("label:Switch");
  await app.type(input, "retry");
  await app.submit(input);
  await app.waitFor("label:Discard");
  await app.type(input, "keep this");
  await app.press("label:Discard");
  expect(app.value(input)).toBe("keep this");
  expect(app.shows("label:Retry")).toBe(false);
});

test("a folded paste survives switching and sends its text and UTF-16 range", async () => {
  const app = await fixture();
  const log = "a\nb\nc\nd";
  await app.type(input, "😀");
  await app.paste(input, { text: log });
  await app.waitFor("label:Pasted text · 7 B");
  await app.type(input, "!");
  await app.press("label:Switch");
  await app.press("label:Switch");
  expect(app.shows("label:Pasted text · 7 B")).toBe(true);
  expect(app.value(input)).toBe("!");
  await app.submit(input);
  await app.waitFor(
    `text:sent ${JSON.stringify(["alpha", `😀${log}!`, "queue", []])}`,
  );
  expect(app.shows("text:[[2,9]]")).toBe(true);
});

test("an interrupted attachment can be retried in its original chat", async () => {
  const app = await fixture();
  await app.paste(input, { files: ["assets/onboard.jpg"] });
  await app.waitFor("label:Retry");
  await app.type(input, "photo");
  await app.submit(input);
  expect(app.value(input)).toBe("photo");
  await app.press("label:Switch");
  expect(app.shows("label:Retry")).toBe(false);
  await app.press("label:Switch");
  await app.press("label:Retry");
  await app.waitFor("label:onboard.jpg");
  expect(app.value(input)).toBe("photo");
});

test("phone task completion accepts Enter and Shift+Enter keeps a second line in the draft", async () => {
  const app = await fixture(390);
  await app.type(input, "看，#");
  await app.submit(input);
  expect(app.value(input)).toBe("看，#1 ");
  await app.keyboard.press("shift+enter");
  await app.type(input, "ok");
  expect(app.value(input)).toBe("看，#1 \nok");
  await app.submit(input);
  await app.waitFor(
    `text:sent ${JSON.stringify(["alpha", "看，#1 \nok", "queue", []])}`,
  );
});

test("pasted short text is added to the draft and the caret follows it", async () => {
  const app = await fixture();
  // The test keyboard's arrow keys do not move the input's caret, so a paste in the middle of
  // the draft cannot be set up here; this covers the caret after the pasted text.
  await app.type(input, "ac");
  await app.paste(input, { text: "xyz" });
  expect(app.value(input)).toBe("acxyz");
  await app.paste(input, { text: "!" });
  expect(app.value(input)).toBe("acxyz!");
});

test("a paste beyond the message limit is attached as a text file", async () => {
  const app = await fixture();
  await app.paste(input, { text: "x".repeat(100001) });
  await app.waitFor("label:Pasted text.txt");
  expect(app.value(input)).toBe("");
});

test("removing a folded paste keeps the words on both sides", async () => {
  const app = await fixture();
  await app.type(input, "left");
  await app.paste(input, { text: "1\n2\n3\n4" });
  await app.type(input, "right");
  await app.press("label:Remove pasted text");
  expect(app.value(input)).toBe("leftright");
});

test("a tablet shows three members and expands the overflow chip", async () => {
  const app = await fixture(640);
  await app.waitFor("label:+2");
  await app.press("label:+2");
  expect(app.shows("label:+2")).toBe(false);
  expect(app.shows("label:Cyrus")).toBe(true);
});

test("reconnecting drains a saved message even when another chat is open", async () => {
  const app = await open("./composer-fixture.tsx", {
    platform: "macos",
    width: 720,
    height: 600,
    storage: {
      'eta.composer.v1.["http://example.invalid","beta"]': JSON.stringify({
        text: "draft in beta",
        attachments: [],
        prefix: [],
        outgoing: [{ id: "earlier-id", text: "saved send", attachments: [] }],
      }),
    },
  });
  await app.waitFor('text:sent ["beta","saved send","queue",[]]');
  expect(app.value(input)).toBe("");
  await app.press("label:Switch");
  expect(app.value(input)).toBe("draft in beta");
});

test("a queued message waits above the box and pulls back above the draft", async () => {
  const app = await fixture();
  await app.type(input, "current");
  await app.press("label:Queue one");
  expect(app.shows("label:Queued message: earlier")).toBe(true);
  expect(app.shows("text:Queued · waits for Ada to finish")).toBe(true);
  await app.press("label:Pull back into the box: earlier");
  expect(app.shows("label:Queued message: earlier")).toBe(false);
  expect(app.value(input)).toBe("earlier\n\ncurrent");
});

test("a queued message the host had already handed on stays out of the box", async () => {
  const app = await fixture();
  await app.type(input, "current");
  await app.press("label:Queue one");
  await app.press("label:Hand it on");
  await app.press("label:Pull back into the box: earlier");
  await app.waitFor("text:Ada already read this one");
  expect(app.value(input)).toBe("current");
});

test("inserting a queued message that failed says why", async () => {
  const app = await fixture();
  await app.press("label:Queue one");
  await app.press("label:Insert into this turn: earlier");
  await app.waitFor("text:Could not insert it: lane closed");
  expect(app.shows("label:Queued message: earlier")).toBe(true);
});

test("a second pasted file waits for the first upload in the same draft", async () => {
  const app = await fixture();
  await app.paste(input, { files: ["test/composer.test.tsx"] });
  await app.paste(input, { files: ["test/composer-fixture.tsx"] });
  await app.press("label:Finish upload");
  await app.waitFor("label:composer-fixture.tsx");
  expect(app.shows("label:composer.test.tsx")).toBe(true);
});
