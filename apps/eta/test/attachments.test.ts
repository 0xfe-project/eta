/**
 * Files attached to a message: uploaded in chunks over the wire, claimed by the message that
 * carries them, and handed to the agent as files it can open, wherever its session runs.
 */
import type { AttachmentView, SendResult } from "@eta/client-contracts";
import type { World } from "./support/world";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "./support/host";
import { say, scriptedModels } from "./support/models";
import { remoteWorld } from "./support/remote";
import { world } from "./support/world";

/** A small PNG header is enough: nothing here decodes the picture. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

/** Upload `bytes` in pieces of `piece` bytes; resolves to what the host says the file is. */
async function upload(
  w: World,
  conversationId: string,
  bytes: Uint8Array,
  name = "notes.txt",
  contentType = "text/plain",
  options: { piece?: number; uploadId?: string } = {},
): Promise<AttachmentView> {
  const piece = options.piece ?? 100;
  const uploadId = options.uploadId ?? crypto.randomUUID();
  const count = Math.max(1, Math.ceil(bytes.byteLength / piece));
  let result: { attachment: AttachmentView | null } = { attachment: null };
  for (let index = 0; index < count; index += 1) {
    result = (await w.client.call("conversations", "attach", {
      conversationId,
      uploadId,
      name,
      contentType,
      index,
      last: index === count - 1,
      data: Buffer.from(
        bytes.subarray(index * piece, (index + 1) * piece),
      ).toString("base64"),
    })) as typeof result;
  }
  return result.attachment!;
}

async function ada(w: World, path?: string) {
  const agent = await w.agent("Ada");
  const project = await w.project({ stewardId: agent.id, path });
  const group = await w.group(project.id, [agent.id]);
  await w.watch(group.id);
  return { agent, project, group };
}

const originalHome = process.env.HOME;
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

describe("uploading", () => {
  it("assembles the chunks into a file under the data directory, per conversation", async () => {
    const w = await world();
    const { group } = await ada(w);
    const bytes = Buffer.from("line one\nline two\n".repeat(50));
    const file = await upload(w, group.id, bytes);
    expect(file).toMatchObject({
      name: "notes.txt",
      contentType: "text/plain",
      size: bytes.byteLength,
    });
    const stored = join(
      w.host.dataDir,
      "attachments",
      group.id,
      `${file.id}-notes.txt`,
    );
    expect(await readFile(stored)).toEqual(bytes);
    // No half-written leftovers beside it.
    expect(
      await readdir(join(w.host.dataDir, "attachments", group.id)),
    ).toEqual([`${file.id}-notes.txt`]);
  });

  it("keeps a name to a name: no path, no dots in front", async () => {
    const w = await world();
    const { group } = await ada(w);
    const file = await upload(
      w,
      group.id,
      Buffer.from("x"),
      "../../.etc/passwd",
    );
    expect(file.name).toBe("passwd");
    const hidden = await upload(w, group.id, Buffer.from("x"), "..bashrc");
    expect(hidden.name).toBe("bashrc");
  });

  it("refuses chunks out of order, a bad id, an empty file and a file that is too large", async () => {
    const w = await world();
    const { group } = await ada(w);
    const attach = (args: Record<string, unknown>) =>
      w.client.call("conversations", "attach", {
        conversationId: group.id,
        name: "a.bin",
        data: Buffer.from("abc").toString("base64"),
        ...args,
      });
    const id = crypto.randomUUID();
    await attach({ uploadId: id, index: 0 });
    await expect(attach({ uploadId: id, index: 2 })).rejects.toThrow(
      /out of order/,
    );
    await expect(attach({ uploadId: "../x", index: 0 })).rejects.toThrow(
      /uuid/,
    );
    await expect(
      attach({ uploadId: crypto.randomUUID(), index: 0, last: true, data: "" }),
    ).rejects.toThrow(/empty/);
    const big = crypto.randomUUID();
    const chunk = Buffer.alloc(384 * 1024, 1).toString("base64");
    let refused: unknown;
    for (let index = 0; index < 60 && refused === undefined; index += 1)
      await attach({ uploadId: big, index, data: chunk }).catch((error) => {
        refused = error;
      });
    expect(String(refused)).toMatch(/at most 20 MB/);
  });

  it("answers a resent last chunk with the same file", async () => {
    const w = await world();
    const { group } = await ada(w);
    const uploadId = crypto.randomUUID();
    const first = await upload(
      w,
      group.id,
      Buffer.from("same"),
      "a.txt",
      "text/plain",
      {
        uploadId,
      },
    );
    const again = await upload(
      w,
      group.id,
      Buffer.from("same"),
      "a.txt",
      "text/plain",
      {
        uploadId,
      },
    );
    expect(again).toEqual(first);
  });

  it("can take back a file that was not sent, and only that", async () => {
    const w = await world();
    const { group } = await ada(w);
    const kept = await upload(w, group.id, Buffer.from("keep"));
    const dropped = await upload(w, group.id, Buffer.from("drop"));
    const unattach = async (id: string) =>
      (
        (await w.client.call("conversations", "unattach", {
          conversationId: group.id,
          attachmentId: id,
        })) as { removed: boolean }
      ).removed;
    expect(await unattach(dropped.id)).toBe(true);
    expect(await unattach(dropped.id)).toBe(false);
    expect(
      existsSync(
        join(
          w.host.dataDir,
          "attachments",
          group.id,
          `${dropped.id}-notes.txt`,
        ),
      ),
    ).toBe(false);
    const sent = await w.send(group.id, "", { attachments: [kept.id] });
    await w.settled(group.id, sent.replies[0]!.id);
    expect(await unattach(kept.id)).toBe(false);
  });
});

describe("sending with files", () => {
  it("tells the agent where each file is, and the file is there to open", async () => {
    const { models, requests } = scriptedModels(() => say("read it"));
    const w = await world({ models });
    const { group } = await ada(w);
    const bytes = Buffer.from("the quarterly numbers");
    const file = await upload(w, group.id, bytes, "q3 report.txt");
    const sent = await w.send(group.id, "please summarise", {
      attachments: [file.id],
    });
    expect(sent.message.data.attachments).toEqual([file]);
    await w.settled(group.id, sent.replies[0]!.id);

    const told = requests[0]!.transcript.join("\n");
    expect(told).toContain("please summarise");
    const path = /\[attachment: (.+?) \(text\/plain, 21 bytes\)\]/.exec(
      told,
    )?.[1];
    expect(path).toBeDefined();
    expect(path).toContain(join(w.host.dataDir, "attachments", group.id));
    expect(await readFile(path!)).toEqual(bytes);
  });

  it("lets a message be only a file", async () => {
    const { models, requests } = scriptedModels(() => say("got it"));
    const w = await world({ models });
    const { group } = await ada(w);
    const file = await upload(
      w,
      group.id,
      Buffer.from("data"),
      "d.csv",
      "text/csv",
    );
    const sent = await w.send(group.id, "", { attachments: [file.id] });
    expect(sent.message.text).toBe("");
    await w.settled(group.id, sent.replies[0]!.id);
    expect(requests[0]!.transcript.join("\n")).toContain("d.csv");
    await expect(w.send(group.id, "")).rejects.toThrow(/needs text/);
  });

  it("refuses files that are not this conversation's, were already sent, or are too many", async () => {
    const { models } = scriptedModels(() => say("ok"));
    const w = await world({ models });
    const { group, agent, project } = await ada(w);
    const other = await w.group(project.id, [agent.id], "other");
    const file = await upload(w, group.id, Buffer.from("x"));
    await expect(
      w.send(other.id, "hi", { attachments: [file.id] }),
    ).rejects.toThrow(/no such attachment/);
    await expect(
      w.send(group.id, "hi", { attachments: [crypto.randomUUID()] }),
    ).rejects.toThrow(/no such attachment/);
    await expect(
      w.send(group.id, "hi", {
        attachments: Array.from({ length: 11 }, () => crypto.randomUUID()),
      }),
    ).rejects.toThrow(/at most 10/);
    const sent = await w.send(group.id, "first", { attachments: [file.id] });
    await w.settled(group.id, sent.replies[0]!.id);
    await expect(
      w.send(group.id, "again", { attachments: [file.id] }),
    ).rejects.toThrow(/already sent/);
  });

  it("is the same message when a send is retried with its client id", async () => {
    const { models } = scriptedModels(() => say("ok"));
    const w = await world({ models });
    const { group } = await ada(w);
    const file = await upload(w, group.id, Buffer.from("x"));
    const args = { attachments: [file.id], clientId: crypto.randomUUID() };
    const one = await w.send(group.id, "hi", args);
    const two = await w.send(group.id, "hi", args);
    expect(two.message.id).toBe(one.message.id);
    await w.settled(group.id, one.replies[0]!.id);
  });
});

describe("images", () => {
  it("also go to the model as images when it takes them", async () => {
    const { models, requests } = scriptedModels(() => say("a pixel"), {
      vision: true,
    });
    const w = await world({ models });
    const { group } = await ada(w);
    const file = await upload(w, group.id, PNG, "pixel.png", "image/png");
    const sent = await w.send(group.id, "what is this", {
      attachments: [file.id],
    });
    await w.settled(group.id, sent.replies[0]!.id);
    expect(requests[0]!.images).toBe(1);
    expect(requests[0]!.transcript.join("\n")).toContain("pixel.png");
  });

  it("stay a file when the model does not take them", async () => {
    const { models, requests } = scriptedModels(() => say("no eyes"));
    const w = await world({ models });
    const { group } = await ada(w);
    const file = await upload(w, group.id, PNG, "pixel.png", "image/png");
    const sent = await w.send(group.id, "what is this", {
      attachments: [file.id],
    });
    await w.settled(group.id, sent.replies[0]!.id);
    expect(requests[0]!.images).toBe(0);
    expect(requests[0]!.transcript.join("\n")).toContain("pixel.png");
  });
});

describe("on a remote machine", () => {
  it.skipIf(process.platform === "win32")(
    "is written on the daemon's machine through the link, whole and once",
    async () => {
      // The daemon runs in this process, so "its home" is whatever HOME says now.
      const home = await tempDir("eta-daemon-home-");
      await mkdir(home, { recursive: true });
      process.env.HOME = home;
      const { models, requests } = scriptedModels(() => say("seen"));
      const r = await remoteWorld({ models });
      const { group } = await r.agents("Ada");
      // Bigger than one piece over the link, with content that would show a gap or a repeat.
      const bytes = Buffer.alloc(7 * 1024 * 1024 + 123);
      for (let i = 0; i < bytes.length; i += 1)
        bytes[i] = (i * 31 + (i >> 8)) & 255;
      const file = await upload(
        r,
        group.id,
        bytes,
        "big.bin",
        "application/octet-stream",
        {
          piece: 384 * 1024,
        },
      );
      const sent = await r.send(group.id, "look", { attachments: [file.id] });
      await r.settled(group.id, sent.replies[0]!.id);

      const path = /\[attachment: (.+?) \(application\/octet-stream/.exec(
        requests[0]!.transcript.join("\n"),
      )?.[1];
      expect(path).toBe(
        join(home, ".eta", "uploads", group.id, `${file.id}-big.bin`),
      );
      expect((await readFile(path!)).equals(bytes)).toBe(true);
      // The primary keeps its own copy; the agent was pointed at the daemon's.
      expect(
        existsSync(
          join(r.host.dataDir, "attachments", group.id, `${file.id}-big.bin`),
        ),
      ).toBe(true);
    },
    60_000,
  );

  it("sends an image to the remote model as an image, over the link", async () => {
    const home = await tempDir("eta-daemon-home-");
    process.env.HOME = home;
    const { models, requests } = scriptedModels(() => say("a pixel"), {
      vision: true,
    });
    const r = await remoteWorld({ models });
    const { group } = await r.agents("Ada");
    const file = await upload(r, group.id, PNG, "pixel.png", "image/png");
    const sent = await r.send(group.id, "what is this", {
      attachments: [file.id],
    });
    await r.settled(group.id, sent.replies[0]!.id);
    expect(requests[0]!.images).toBe(1);
  });

  it("names a file that could not be delivered instead of failing the reply", async () => {
    const { models, requests } = scriptedModels(() => say("seen"));
    const r = await remoteWorld({ models });
    const { group } = await r.agents("Ada");
    const file = await upload(r, group.id, Buffer.from("x"));
    // The session exists first, so the link is up when the session is made; then the file's
    // place on the primary is taken away.
    const first = await r.send(group.id, "hello");
    await r.settled(group.id, first.replies[0]!.id);
    const { rm } = await import("node:fs/promises");
    await rm(
      join(r.host.dataDir, "attachments", group.id, `${file.id}-notes.txt`),
    );
    const sent: SendResult = await r.send(group.id, "look", {
      attachments: [file.id],
    });
    const done = await r.settled(group.id, sent.replies[0]!.id);
    expect(done.status).toBe("done");
    expect(requests.at(-1)!.transcript.join("\n")).toContain(
      "could not be put where you can read it",
    );
  });
});
