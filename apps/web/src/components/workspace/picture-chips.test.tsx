import type { RunImage } from "@eta/client-contracts";
import type { FilePart } from "@/lib/composer";
import { act } from "react";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { setWire } from "@/lib/wire";
import { beginUpload, useOutbox } from "@/queries/outbox";
import { closeBrowser, hasBrowser, onPage } from "@/test-browser";
import { productHost } from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";
import { AttachmentChip, ComposerBlock } from "./composer-block";
import { ImageStrip } from "./transcript/image-strip";

// An image attachment's `[name · size]` chip, in the composer and in a sent message, and a run's
// thumbnails: each previews its picture on focus or hover and opens it over the window on a click.

let made: string[];
let revoked: string[];
let fetched: string[];

beforeEach(() => {
  made = [];
  revoked = [];
  fetched = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
    const url = `blob:picture-${made.length + 1}`;
    made.push(url);
    return url;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
    revoked.push(url);
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    fetched.push(String(input));
    return new Response(new Blob(["png"], { type: "image/png" }));
  });
  useOutbox.setState({ drafts: {}, uploads: {}, outgoing: [] });
  const host = productHost();
  host.handle("conversations.attach", (args) => {
    const chunk = args as { uploadId: string; name: string; last: boolean };
    return {
      attachment: chunk.last
        ? {
            id: chunk.uploadId,
            name: chunk.name,
            contentType: "image/png",
            size: 3,
          }
        : null,
    };
  });
  host.handle("conversations.unattach", () => ({ removed: true }));
});
afterEach(async () => {
  await cleanup();
  setWire(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const show = (node: React.ReactNode) => mount(node);

const preview = () => document.querySelector(".picture-preview");
const lightboxBar = () => document.querySelector(".lightbox-bar");

async function focus(element: Element | null | undefined) {
  if (!(element instanceof HTMLElement)) throw new Error("nothing to focus");
  await act(async () => element.focus());
}

describe("a sent message's attachment", () => {
  const picture = {
    id: "0d6f4a52-1f39-4a43-9a7e-1c5a4b6d7e01",
    name: "screen.png",
    contentType: "image/png",
    size: 25_190,
  };

  it("previews a picture, names it, and opens it over the window", async () => {
    // The chip is on screen as soon as it is drawn.
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(
          private readonly seen: (
            entries: { isIntersecting: boolean }[],
          ) => void,
        ) {}
        observe() {
          this.seen([{ isIntersecting: true }]);
        }
        disconnect() {}
      },
    );
    const { container } = await show(<AttachmentChip attachment={picture} />);
    const chip = container.querySelector("button");
    expect(chip?.getAttribute("aria-label")).toContain("screen.png");
    // On screen, the picture is fetched once from the host…
    await flush();
    expect(fetched).toEqual([`/attachments/${picture.id}`]);

    await focus(chip);
    expect(preview()?.textContent).toContain("screen.png · 24.6 KB");
    expect(preview()?.querySelector("img")?.getAttribute("src")).toBe(
      "blob:picture-1",
    );

    await click(chip);
    expect(lightboxBar()?.textContent).toContain("screen.png · 24.6 KB");
    expect(
      document.querySelector(".lightbox-stage img")?.getAttribute("src"),
    ).toBe("blob:picture-1");
    // …and neither the preview nor the lightbox asks again.
    expect(fetched).toHaveLength(1);
  });

  it("stays a line of text when it is not a picture", async () => {
    const { container } = await show(
      <AttachmentChip
        attachment={{
          ...picture,
          name: "notes.txt",
          contentType: "text/plain",
        }}
      />,
    );
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toBe("[notes.txt · 24.6 KB]");
    await flush();
    expect(fetched).toEqual([]);
    expect(preview()).toBeNull();
  });
});

describe("a preview, as a browser draws it", () => {
  afterAll(closeBrowser);

  it("takes no pointer, nor does the box it is placed in", async ({ skip }) => {
    if (!(await hasBrowser())) return skip();
    const part = beginUpload(
      "c1",
      new File(["png"], "paste.png", { type: "image/png" }),
    ) as FilePart;
    const { container } = await show(
      <ComposerBlock part={part} remove={() => {}} expand={() => {}} />,
    );
    await focus(container.querySelector('button[aria-label*="paste.png"]'));
    await flush();
    // While it is being placed the box can lie over the chip: taking the pointer there closed it.
    await onPage(document.body.innerHTML, async (page) => {
      for (const selector of [
        "[data-radix-popper-content-wrapper]",
        ".picture-preview",
      ])
        expect(
          await page
            .locator(selector)
            .evaluate((element) => getComputedStyle(element).pointerEvents),
        ).toBe("none");
    });
  });
});

describe("a picture in the composer", () => {
  const image = () => new File(["png"], "paste.png", { type: "image/png" });

  it("previews the pasted file itself, without the network", async () => {
    const part = beginUpload("c1", image()) as FilePart;
    const { container } = await show(
      <ComposerBlock part={part} remove={() => {}} expand={() => {}} />,
    );
    const chip = container.querySelector(
      'button[aria-label*="paste.png"]:not([aria-label^="移除"])',
    );
    await focus(chip);
    await flush();
    expect(preview()?.querySelector("img")?.getAttribute("src")).toBe(
      "blob:picture-1",
    );
    await click(chip);
    expect(lightboxBar()?.textContent).toContain("paste.png · 3 B");
    expect(fetched).toEqual([]);
  });

  it("lets the file's URL go when the block is taken out", async () => {
    const part = beginUpload("c1", image()) as FilePart;
    const remove = vi.fn();
    const { container } = await show(
      <ComposerBlock part={part} remove={remove} expand={() => {}} />,
    );
    await click(container.querySelector('button[aria-label^="移除"]'));
    await flush();
    expect(remove).toHaveBeenCalled();
    expect(revoked).toEqual(["blob:picture-1"]);
  });

  it("makes no URL for a file that is not a picture", async () => {
    const part = beginUpload(
      "c1",
      new File(["x"], "a.txt", { type: "text/plain" }),
    ) as FilePart;
    const { container } = await show(
      <ComposerBlock part={part} remove={() => {}} expand={() => {}} />,
    );
    expect(made).toEqual([]);
    expect(container.querySelector('button[aria-label*="a.txt"]')).toBe(
      container.querySelector('button[aria-label^="移除"]'),
    );
  });
});

describe("a run's thumbnails", () => {
  const png = (index: number): RunImage => ({
    mimeType: "image/png",
    data: "iVBORw0KGgo=",
    bytes: 2048,
    entryId: "e1",
    index,
  });

  it("preview on focus and walk through the lightbox with the arrows", async () => {
    const { container } = await show(
      <ImageStrip sessionId="s1" images={[png(0), png(1)]} />,
    );
    const [first] = container.querySelectorAll(".image-thumb");
    await focus(first);
    expect(preview()?.textContent).toContain("PNG · 2 KB");

    await click(first);
    expect(lightboxBar()?.textContent).toContain("1 / 2 · PNG · 2 KB");
    const dialog = document.querySelector(".lightbox")!;
    await act(async () => {
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(lightboxBar()?.textContent).toContain("2 / 2");
  });
});
