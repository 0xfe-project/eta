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

test("files a file manager copied or dropped are read from their file: URLs and sent", async () => {
  const app = await fixture();
  // The test's own directory, as a file manager names it (`import.meta.url` is `asset:` here).
  const uri = (path: string) =>
    `file://${new URL(path, import.meta.url).pathname}`;
  await app.paste(input, { uris: [uri("fixtures/pixel.png")] });
  await app.waitFor("label:View picture pixel.png · 0.0 KB");
  await app.dropFiles(input, [uri("composer-fixture.tsx")]);
  await app.waitFor("label:File composer-fixture.tsx");
  expect(screen(app)).not.toContain("can't attach");
  await app.keyboard.press("enter");
  await app.waitFor("text:attachments pixel.png,composer-fixture.tsx");
});

test("a copied folder is refused, and its block says why", async () => {
  const app = await fixture();
  // As Finder copies a folder: its URL ends with a slash.
  const folder = `file://${new URL("fixtures/", import.meta.url).pathname}`;
  await app.paste(input, { uris: [folder] });
  const why = "fixtures is a folder. Attach the files in it instead.";
  const block = `label:Can't attach fixtures: ${why}`;
  await app.waitFor(block);
  await app.press(block);
  await app.waitFor(`text:${why}`);
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
});

test("removing a folded paste keeps the words on both sides", async () => {
  const app = await fixture();
  await app.type(input, "left");
  await app.paste(input, { text: "1\n2\n3\n4" });
  await app.type(input, "right");
  // Its × shows while the pointer is over it.
  await app.hover("label:Unfold pasted text (4 lines)");
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
  await app.waitFor("label:View picture onboard.jpg · 0.0 KB");
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
  expect(app.shows("text:Insert into this turn")).toBe(false);
  expect(app.shows("label:Delete this one: earlier")).toBe(true);
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

test("a queued message can be deleted from the queue without entering the box", async () => {
  const app = await fixture();
  await app.type(input, "draft");
  await app.press("label:Queue one");
  expect(app.shows("label:Queued message: earlier")).toBe(true);
  await app.press("label:Delete this one: earlier");
  await app.waitUntil(() => !app.shows("label:Queued message: earlier"));
  await app.keyboard.press("enter");
  await app.waitFor(sent(["alpha", "draft", "queue", []]));
});

test("a second pasted file waits for the first upload in the same draft", async () => {
  const app = await fixture();
  await app.paste(input, { files: ["test/composer.test.tsx"] });
  await app.paste(input, { files: ["test/composer-fixture.tsx"] });
  await app.press("label:Finish upload");
  await app.waitFor("label:File composer-fixture.tsx");
  expect(app.shows("label:File composer.test.tsx")).toBe(true);
});

test("a paste is an undo step of its own, even right after typing", async () => {
  const app = await fixture();
  await app.type(input, "typed");
  await app.paste(input, { text: "1\n2\n3\n4" });
  await app.keyboard.press("mod+z");
  expect(app.shows("label:Unfold pasted text (4 lines)")).toBe(false);
  await app.keyboard.press("enter");
  await app.waitFor(sent(["alpha", "typed", "queue", []]));
});

test("a pasted BMP screenshot goes in as a PNG and other images keep their name", async () => {
  const app = await fixture();
  await app.paste(input, { files: ["test/paste-pixel.bmp"] });
  await app.waitFor("label:View picture paste-pixel.png · 0.0 KB");
  expect(app.shows("label:Image paste-pixel.bmp")).toBe(false);
  // The fixture fails a first upload of onboard.jpg: its block still has its own name.
  await app.paste(input, { files: ["assets/onboard.jpg"] });
  await app.waitFor("label:Retry uploading onboard.jpg");
});

test("an uploaded picture previews on hover and opens from its block, from its own bytes", async () => {
  const app = await fixture();
  await app.paste(input, { files: ["test/fixtures/pixel.png"] });
  const block = "label:View picture pixel.png · 0.0 KB";
  await app.waitFor(block);
  await app.hover(block);
  await app.wait(300);
  expect(app.shows("label:pixel.png · 0.0 KB")).toBe(true);
  await app.press(block);
  await app.waitFor("text:pixel.png · 0.0 KB");
  expect(app.shows("id:picture-stage")).toBe(true);
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("id:picture-stage"));
  // The draft's picture is the file it sent: the host is never asked for it.
  expect(
    app.requests().some((request) => request.url.includes("/attachments/")),
  ).toBe(false);
  await app.press("label:Remove pixel.png");
  await app.waitUntil(() => !app.shows(block));
});

const quoted = "> Line one\n>\n> Line two";

test("a quoted selection goes after the draft, and a second quote after the first", async () => {
  const app = await fixture();
  await app.type(input, "Look at this:");
  await app.press("label:Quote");
  // The caret is on the line below the quote.
  await app.type(input, "Why?");
  await app.press("label:Quote");
  await app.type(input, "And this?");
  await app.keyboard.press("enter");
  await app.waitFor(
    sent([
      "alpha",
      `Look at this:\n\n${quoted}\n\nWhy?\n\n${quoted}\n\nAnd this?`,
      "queue",
      [],
    ]),
  );
});

test("two quotes in a row stay two quotes", async () => {
  const app = await fixture();
  await app.press("label:Quote");
  await app.press("label:Quote");
  await app.keyboard.press("enter");
  await app.waitFor(sent(["alpha", `${quoted}\n\n${quoted}`, "queue", []]));
});

test("a quote keeps the draft's words and files, and stays in its own chat", async () => {
  const app = await fixture();
  await app.type(input, "😀 see ");
  await app.paste(input, { files: ["test/composer-fixture.tsx"] });
  await app.waitFor("label:File composer-fixture.tsx");
  await app.press("label:Quote");
  await app.type(input, "ok");
  await app.press("label:Switch");
  expect(screen(app)).not.toContain("Line one");
  await app.press("label:Switch");
  await app.waitFor("label:File composer-fixture.tsx");
  await app.keyboard.press("enter");
  await app.waitFor("text:attachments composer-fixture.tsx");
  expect(screen(app)).toContain(
    `sent ${JSON.stringify(["alpha", `😀 see \n\n${quoted}\n\nok`, "queue"]).slice(0, -1)},[`,
  );
});

test("one undo takes a quote back out", async () => {
  const app = await fixture();
  await app.type(input, "keep");
  // Changes within half a second undo together, as typing does.
  await app.wait(600);
  await app.press("label:Quote");
  await app.keyboard.press("mod+z");
  expect(screen(app)).not.toContain("Line one");
  await app.keyboard.press("enter");
  await app.waitFor(sent(["alpha", "keep", "queue", []]));
});

test("Markdown typed turns into formatting and goes out as Markdown; Enter is a list's and a code block's own", async () => {
  const app = await fixture();
  await app.type(input, "## Plan");
  await app.keyboard.press("shift+enter");
  await app.type(input, "- keep the **band** ");
  // In a list ⏎ is a new item, and on an empty item it leaves the list: nothing is sent.
  await app.keyboard.press("enter");
  await app.type(input, "two");
  await app.keyboard.press("enter");
  await app.keyboard.press("enter");
  expect(screen(app)).not.toContain("sent [");
  // A fence and ⏎ make a code block; ⏎ in it is a new line, ⌘⏎ leaves it.
  await app.type(input, "```ts");
  await app.keyboard.press("enter");
  await app.type(input, "a = 1");
  await app.keyboard.press("enter");
  await app.type(input, "b = 2");
  await app.keyboard.press("mod+enter");
  await app.type(input, "done");
  expect(screen(app)).not.toContain("sent [");
  await app.keyboard.press("enter");
  await app.waitFor(
    sent([
      "alpha",
      "## Plan\n\n- keep the **band**\n- two\n\n```ts\na = 1\nb = 2\n```\n\ndone",
      "queue",
      [],
    ]),
  );
});

test("Markdown pasted is formatted, and code from an editor is a code block", async () => {
  const app = await fixture();
  await app.paste(input, { text: "## Rollout\n- week 1: **team**" });
  await app.keyboard.press("enter");
  await app.keyboard.press("enter");
  await app.paste(input, {
    text: "const a = 1;\nconst b = 2;\n",
    html: '<div style="font-family: Menlo, monospace; white-space: pre;"><div>const a = 1;</div><div>const b = 2;</div></div>',
  });
  await app.keyboard.press("enter");
  await app.waitFor(
    sent([
      "alpha",
      "## Rollout\n\n- week 1: **team**\n\n```\nconst a = 1;\nconst b = 2;\n```",
      "queue",
      [],
    ]),
  );
});
