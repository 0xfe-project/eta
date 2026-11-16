/**
 * A hold on the one wait inside a wake's briefing: putting the files of the messages it tells
 * about where the session can open them (`AttachmentStore.deliver`). A test that sends a message
 * with a file can hold its briefing there and let something happen in between — the turn it is
 * joining ending, say — before the engine goes on.
 */
import type { AttachmentView } from "@eta/client-contracts";
import { Buffer } from "node:buffer";
import { afterEach, vi } from "vitest";
import { AttachmentStore } from "../../src/conversations/attachments";
import { gate } from "./models";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Hold the next delivery until `release`; the ones after it go through. */
export function holdNextDelivery(): {
  /** Settles when a briefing has reached the delivery and is waiting there. */
  reached: Promise<void>;
  release: () => void;
} {
  const reached = gate();
  const released = gate();
  const deliver = AttachmentStore.prototype.deliver;
  let held = false;
  vi.spyOn(AttachmentStore.prototype, "deliver").mockImplementation(
    async function (this: AttachmentStore, ...args) {
      if (!held) {
        held = true;
        reached.open();
        await released.opened;
      }
      return deliver.apply(this, args);
    },
  );
  return { reached: reached.opened, release: released.open };
}

/** A small text file uploaded to a conversation in one piece; its id goes in `send`'s `attachments`. */
export async function uploadNote(
  client: {
    call: (target: string, action: string, args: unknown) => Promise<unknown>;
  },
  conversationId: string,
  text = "a note",
): Promise<string> {
  const result = (await client.call("conversations", "attach", {
    conversationId,
    uploadId: crypto.randomUUID(),
    name: "note.txt",
    contentType: "text/plain",
    index: 0,
    last: true,
    data: Buffer.from(text).toString("base64"),
  })) as { attachment: AttachmentView | null };
  return result.attachment!.id;
}
