/**
 * A sender may say where each attachment stood among the words. The host checks that each anchor
 * names an attachment of the message and an offset inside its text, writes them onto the row
 * verbatim, and the sender finds them again in the reply and in the pushed rows.
 */
import type { AttachmentView } from "@eta/client-contracts";
import type { World } from "./support/world";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { world } from "./support/world";

/** A small PNG header is enough: nothing here decodes the picture. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

/** One agent in a conversation, and a picture uploaded to it. */
async function chat(w: World) {
  const agent = await w.agent("Ada");
  const project = await w.project();
  const group = await w.group(project.id, [agent.id]);
  await w.watch(group.id);
  const picture = async (): Promise<AttachmentView> => {
    const sent = (await w.client.call("conversations", "attach", {
      conversationId: group.id,
      uploadId: crypto.randomUUID(),
      name: "shot.png",
      contentType: "image/png",
      index: 0,
      last: true,
      data: PNG.toString("base64"),
    })) as { attachment: AttachmentView };
    return sent.attachment;
  };
  return { group, picture };
}

describe("the anchors a send carries", () => {
  it("writes them onto the row verbatim, in the reply and in the pushed row", async () => {
    const w = await world();
    const { group, picture } = await chat(w);
    const [first, second] = [await picture(), await picture()];
    const anchors = [
      { attachmentId: first.id, at: 3 },
      { attachmentId: second.id, at: 7 },
    ];
    const sent = await w.send(group.id, "看这张 再看这张", {
      attachments: [first.id, second.id],
      anchors,
    });
    expect(sent.message.data.anchors).toEqual(anchors);
    await until(() =>
      w.rows(group.id).some((row) => row.id === sent.message.id),
    );
    expect(w.row(group.id, sent.message.id)!.data.anchors).toEqual(anchors);
  });

  it("keeps a message that sends none free of the key", async () => {
    const w = await world();
    const { group, picture } = await chat(w);
    const file = await picture();
    const sent = await w.send(group.id, "只有文字", { attachments: [file.id] });
    expect(sent.message.data.anchors).toBeUndefined();
  });

  it("takes an anchor at either end of the text", async () => {
    const w = await world();
    const { group, picture } = await chat(w);
    const file = await picture();
    const sent = await w.send(group.id, "abc", {
      attachments: [file.id],
      anchors: [
        { attachmentId: file.id, at: 0 },
        { attachmentId: file.id, at: 3 },
      ],
    });
    expect(sent.message.data.anchors).toHaveLength(2);
  });

  it("refuses an anchor outside the text", async () => {
    const w = await world();
    const { group, picture } = await chat(w);
    const file = await picture();
    for (const at of [-1, 4])
      await expect(
        w.send(group.id, "abc", {
          attachments: [file.id],
          anchors: [{ attachmentId: file.id, at }],
        }),
      ).rejects.toThrow(/outside the text/);
  });

  it("refuses an anchor whose id is not an attachment of the message", async () => {
    const w = await world();
    const { group, picture } = await chat(w);
    const [sentWith, left] = [await picture(), await picture()];
    await expect(
      w.send(group.id, "abc", {
        attachments: [sentWith.id],
        anchors: [{ attachmentId: left.id, at: 1 }],
      }),
    ).rejects.toThrow(/not an attachment of this message/);
  });

  it("refuses anchors that are not an id and an integer", async () => {
    const w = await world();
    const { group } = await chat(w);
    await expect(
      w.client.call("conversations", "send", {
        conversationId: group.id,
        text: "abc",
        anchors: [{ attachmentId: "x", at: 1.5 }],
      }),
    ).rejects.toThrow(/anchors/);
  });
});
