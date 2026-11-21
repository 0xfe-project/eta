import { expect, open, test } from "nsh/test";

const input = "id:eta-editor";
const fixture = (width = 720, options: { clipboard?: string } = {}) =>
  open("./composer-fixture.tsx", {
    platform: "macos",
    width,
    height: 600,
    clock: { time: 1000 },
    ...options,
  });
type App = Awaited<ReturnType<typeof fixture>>;
/** The words on screen, the editor's included. */
const screen = (app: App) => app.texts().join("\n");
const sent = (args: unknown[]) => `text:sent ${JSON.stringify(args)}`;

test("a draft returns to its own chat and a failed delivery can be retried with the same id", async () => {
  const app = await fixture();
  await app.type(input, "retry");
  await app.press("label:Switch");
  expect(screen(app)).not.toContain("retry");
  await app.type(input, "elsewhere");
  await app.press("label:Switch");
  expect(screen(app)).toContain("retry");
  await app.keyboard.press("enter");
  await app.waitFor("label:Retry");
  await app.press("label:Switch");
  expect(screen(app)).toContain("elsewhere");
  await app.press("label:Switch");
  await app.press("label:Retry");
  await app.waitFor(sent(["alpha", "retry", "queue", []]));
});

test("Enter while an input method composes neither sends nor picks; Tab picks the highlighted row", async () => {
  const app = await fixture();
  await app.type(input, "询问，@");
  await app.waitFor("role:listbox");
  await app.compose(input, "a");
  await app.keyboard.press("enter");
  expect(screen(app)).not.toContain("sent [");
  await app.compose(input, "");
  await app.keyboard.press("down");
  await app.keyboard.press("tab");
  expect(app.shows("role:listbox")).toBe(false);
  await app.keyboard.press("enter");
  await app.waitFor(sent(["alpha", "询问，@README.md", "queue", []]));
});

test("Escape closes the list first and only an empty draft can stop the running replies", async () => {
  const app = await fixture();
  await app.type(input, "@");
  await app.waitFor("role:listbox");
  await app.keyboard.press("escape");
  expect(app.shows("role:listbox")).toBe(false);
  await app.keyboard.press("escape");
  expect(app.shows("text:stopped alpha")).toBe(false);
  await app.keyboard.press("backspace");
  await app.keyboard.press("escape");
  await app.waitFor("text:stopped alpha");
});

test("a picked member goes in as a mention and out in the text", async () => {
  const app = await fixture();
  await app.type(input, "看 @Ad");
  await app.press("label:Mention Ada");
  await app.type(input, "hi");
  await app.keyboard.press("enter");
  await app.waitFor(sent(["alpha", "看 @Ada hi", "queue", []]));
});

test("a pasted file is a block where the caret is, kept with its chat, sent as an attachment", async () => {
  const app = await fixture();
  await app.type(input, "see ");
  await app.paste(input, { files: ["test/composer-fixture.tsx"] });
  await app.waitFor("label:File composer-fixture.tsx");
  await app.type(input, " please");
  await app.press("label:Switch");
  expect(app.shows("label:File composer-fixture.tsx")).toBe(false);
  await app.press("label:Switch");
  await app.waitFor("label:File composer-fixture.tsx");
  await app.keyboard.press("enter");
  await app.waitFor("text:attachments composer-fixture.tsx");
  expect(screen(app)).toContain('sent ["alpha","see  please","queue",[');
});

test("the text of a spreadsheet or Word copy wins over the picture beside it", async () => {
  const app = await fixture(720, { clipboard: "office text" });
  await app.paste(input, {
    text: "office text",
    html: "<b>office text</b>",
    files: ["assets/onboard.jpg"],
  });
  await app.waitFor("text:office text");
  expect(app.shows("label:Image onboard.jpg")).toBe(false);
});

test("a failed send comes back above the new draft, or is discarded on its own", async () => {
  const app = await fixture();
  await app.type(input, "retry");
  await app.keyboard.press("enter");
  await app.waitFor("label:Edit");
  await app.type(input, "later");
  await app.press("label:Edit");
  await app.keyboard.press("enter");
  await app.waitFor(sent(["alpha", "retry\nlater", "queue", []]));
  await app.press("label:Switch");
  await app.type(input, "retry");
  await app.keyboard.press("enter");
  await app.waitFor("label:Discard");
  await app.type(input, "keep this");
  await app.press("label:Discard");
  expect(app.shows("label:Retry")).toBe(false);
  expect(screen(app)).toContain("keep this");
});

test("a long paste folds where the caret is, survives switching and sends its text and UTF-16 range", async () => {
  const app = await fixture();
  const log = "a\nb\nc\nd";
  await app.type(input, "😀");
  await app.paste(input, { text: log });
  await app.waitFor("label:Unfold pasted text (4 lines)");
  await app.type(input, "!");
  await app.press("label:Switch");
  await app.press("label:Switch");
  await app.waitFor("label:Unfold pasted text (4 lines)");
  await app.keyboard.press("enter");
  await app.waitFor(sent(["alpha", `😀${log}!`, "queue", []]));
  expect(app.shows("text:[[2,9]]")).toBe(true);
});

test("a folded paste unfolds into its text, and undo folds it again", async () => {
  const app = await fixture();
<<<<<<< HEAD
  await app.paste(input, { files: ["assets/onboard.jpg"] });
  await app.waitFor("label:Retry");
  await app.type(input, "photo");
  await app.submit(input);
  expect(app.value(input)).toBe("photo");
  await app.press("label:Switch");
  expect(app.shows("label:Retry")).toBe(false);
  await app.press("label:Switch");
  await app.press("label:Retry");
  await app.waitFor("label:View picture onboard.jpg · 0.0 KB");
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
=======
  await app.type(input, "left ");
  // Changes within half a second undo together, as typing does.
  await app.wait(600);
  await app.paste(input, { text: "1\n2\n3\n4" });
  await app.wait(600);
  await app.press("label:Unfold pasted text (4 lines)");
  expect(app.shows("label:Unfold pasted text (4 lines)")).toBe(false);
  expect(screen(app)).toContain("3");
  await app.keyboard.press("mod+z");
  await app.waitFor("label:Unfold pasted text (4 lines)");
>>>>>>> df3038ab (feat(client): one RichEditor-based composer for chats, task comments and the insert popover)
});

test("removing a folded paste keeps the words on both sides", async () => {
  const app = await fixture();
  await app.type(input, "left");
  await app.paste(input, { text: "1\n2\n3\n4" });
  await app.type(input, "right");
  await app.press("label:Remove pasted text");
  await app.keyboard.press("enter");
  await app.waitFor(sent(["alpha", "leftright", "queue", []]));
});

test("an interrupted upload shows on its block and can be retried in its chat", async () => {
  const app = await fixture();
  await app.paste(input, { files: ["assets/onboard.jpg"] });
  await app.waitFor("label:Retry uploading onboard.jpg");
  await app.type(input, "photo");
  await app.keyboard.press("enter");
  expect(screen(app)).not.toContain("sent [");
  await app.press("label:Switch");
  expect(app.shows("label:Retry uploading onboard.jpg")).toBe(false);
  await app.press("label:Switch");
  await app.press("label:Retry uploading onboard.jpg");
  await app.waitFor("label:Image onboard.jpg");
  await app.keyboard.press("enter");
  await app.waitFor("text:attachments onboard.jpg");
});

test("phone: Enter picks a task and Shift+Enter starts a second line", async () => {
  const app = await fixture(390);
  await app.type(input, "看，#");
  await app.waitFor("role:listbox");
  await app.keyboard.press("enter");
  await app.keyboard.press("shift+enter");
  await app.type(input, "ok");
  await app.keyboard.press("enter");
  await app.waitFor(sent(["alpha", "看，#1 \nok", "queue", []]));
});

test("a paste beyond the message limit is attached as a text file", async () => {
  const app = await fixture();
  await app.paste(input, { text: "x".repeat(100001) });
  await app.waitFor("label:File Pasted text.txt");
});

test("a tablet shows three members and expands the overflow chip", async () => {
  const app = await fixture(640);
  await app.waitFor("label:+2");
  await app.press("label:+2");
  expect(app.shows("label:+2")).toBe(false);
  expect(app.shows("label:Cyrus")).toBe(true);
});

test("reconnecting drains a saved message even when another chat is open, and an old draft is read once", async () => {
  const app = await open("./composer-fixture.tsx", {
    platform: "macos",
    width: 720,
    height: 600,
    storage: {
      'eta.composer.v1.["http://example.invalid","beta"]': JSON.stringify({
        text: "draft in beta",
        attachments: [],
        prefix: [{ type: "paste", id: "p", text: "1\n2\n3\n4" }],
        outgoing: [{ id: "earlier-id", text: "saved send", attachments: [] }],
      }),
    },
  });
  await app.waitFor(sent(["beta", "saved send", "queue", []]));
  await app.press("label:Switch");
  await app.waitFor("label:Unfold pasted text (4 lines)");
  expect(screen(app)).toContain("draft in beta");
});

test("a queued message waits above the box and pulls back above the draft", async () => {
  const app = await fixture();
  await app.type(input, "current");
  await app.press("label:Queue one");
  expect(app.shows("label:Queued message: earlier")).toBe(true);
  expect(app.shows("text:Queued · waits for Ada to finish")).toBe(true);
  await app.press("label:Pull back into the box: earlier");
  expect(app.shows("label:Queued message: earlier")).toBe(false);
  await app.keyboard.press("enter");
  await app.waitFor(sent(["alpha", "earlier\n\ncurrent", "queue", []]));
});

test("a queued message the host had already handed on stays out of the box", async () => {
  const app = await fixture();
  await app.type(input, "current");
  await app.press("label:Queue one");
  await app.press("label:Hand it on");
  await app.press("label:Pull back into the box: earlier");
  await app.waitFor("text:Ada already read this one");
  await app.keyboard.press("enter");
  await app.waitFor(sent(["alpha", "current", "queue", []]));
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
  await app.waitFor("label:File composer-fixture.tsx");
  expect(app.shows("label:File composer.test.tsx")).toBe(true);
});

test("a pasted BMP screenshot is attached as a PNG and other images keep their name", async () => {
  const app = await fixture();
  await app.paste(input, { files: ["test/paste-pixel.bmp"] });
  await app.waitFor("label:paste-pixel.png");
  expect(app.shows("label:paste-pixel.bmp")).toBe(false);
  await app.paste(input, { files: ["assets/onboard.jpg"] });
  // the fixture fails a first upload of onboard.jpg; the label still shows it kept its name
  await app.waitFor("text:onboard.jpg · upload interrupted");
});
