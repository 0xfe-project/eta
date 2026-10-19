import type { FakeHost } from "@/test-wire";
import { ATTACH_CHUNK_BYTES } from "@eta/client-contracts";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { setWire } from "@/lib/wire";
import { productHost } from "@/test-product";
import { flush } from "@/test-render";
import { beginUpload, dropUpload, retryUpload, useOutbox } from "./outbox";

// A file pasted or picked into a draft is uploaded at once, a chunk to a call, and the draft's
// block follows it through `uploads`.

interface Attach {
  conversationId: string;
  uploadId: string;
  name: string;
  contentType: string;
  index: number;
  last: boolean;
  data: string;
}

let host: FakeHost;
let chunks: Attach[];
let failNext = false;

beforeEach(() => {
  chunks = [];
  failNext = false;
  useOutbox.setState({ drafts: {}, uploads: {}, outgoing: [] });
  host = productHost();
  host.handle("conversations.attach", (args) => {
    const chunk = args as Attach;
    chunks.push(chunk);
    if (failNext) {
      failNext = false;
      throw new Error("the host said no");
    }
    return {
      attachment: chunk.last
        ? {
            id: chunk.uploadId,
            name: chunk.name,
            contentType: chunk.contentType,
            size: 5,
          }
        : null,
    };
  });
  host.handle("conversations.unattach", () => ({ removed: true }));
});
afterEach(() => setWire(undefined));

const file = (size: number, name = "a.txt", type = "text/plain") =>
  new File([new Uint8Array(size).fill(65)], name, { type });

describe("uploading a file into a draft", () => {
  it("gives the block at once and fills in the attachment when the last chunk is in", async () => {
    const block = beginUpload("c1", file(5));
    expect(block).toMatchObject({
      type: "file",
      name: "a.txt",
      contentType: "text/plain",
      size: 5,
    });
    expect(useOutbox.getState().uploads[block.id]).toEqual({
      conversationId: "c1",
    });
    await flush(20);
    expect(useOutbox.getState().uploads[block.id]).toEqual({
      conversationId: "c1",
      attachment: {
        id: block.id,
        name: "a.txt",
        contentType: "text/plain",
        size: 5,
      },
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      conversationId: "c1",
      uploadId: block.id,
      index: 0,
      last: true,
      data: btoa("AAAAA"),
    });
  });

  it("sends a big file as chunks in order, the last one marked", async () => {
    const block = beginUpload("c1", file(ATTACH_CHUNK_BYTES * 2 + 10));
    await flush(50);
    expect(chunks.map((c) => [c.index, c.last, c.uploadId])).toEqual([
      [0, false, block.id],
      [1, false, block.id],
      [2, true, block.id],
    ]);
    expect(atob(chunks[2]!.data)).toHaveLength(10);
    expect(useOutbox.getState().uploads[block.id]?.attachment).toBeDefined();
  });

  it("says why when the host refuses, and starts over on retry", async () => {
    failNext = true;
    const block = beginUpload("c1", file(5));
    await flush(20);
    expect(useOutbox.getState().uploads[block.id]).toEqual({
      conversationId: "c1",
      error: "the host said no",
    });
    expect(retryUpload(block.id)).toBe(true);
    await flush(20);
    expect(useOutbox.getState().uploads[block.id]?.attachment).toBeDefined();
    expect(chunks.map((c) => c.index)).toEqual([0, 0]);
  });

  it("refuses a file over the limit without sending anything", async () => {
    const block = beginUpload("c1", file(20 * 1024 * 1024 + 1));
    await flush(20);
    expect(useOutbox.getState().uploads[block.id]?.error).toBe(
      "单个附件不能超过 20 MB。",
    );
    expect(chunks).toHaveLength(0);
  });

  it("takes the attachment back from the host when its block is removed", async () => {
    const block = beginUpload("c1", file(5));
    await flush(20);
    dropUpload(block.id);
    await flush(20);
    expect(host.calls.at(-1)).toEqual({
      target: "conversations",
      action: "unattach",
      args: { conversationId: "c1", attachmentId: block.id },
    });
    expect(retryUpload(block.id)).toBe(false);
  });
});

describe("what a reload keeps", () => {
  it("keeps a finished upload with its draft, and fails one the reload cut off", async () => {
    const done = beginUpload("c1", file(5));
    await flush(20);
    useOutbox.getState().setUpload("cut", { conversationId: "c1" });
    useOutbox.getState().setDraft("c1", [done, { ...done, id: "cut" }]);
    await Promise.resolve();
    await useOutbox.persist.rehydrate();
    const { uploads } = useOutbox.getState();
    expect(uploads[done.id]?.attachment).toBeDefined();
    expect(uploads.cut?.error).toMatch(/上传中断/);
  });
});
