/**
 * Sessions the old host wrote — and the ones nothing wrote metadata for.
 *
 * The old `meta.json` said `personaId`/`modelId` and named no `id`; its journal kept its
 * bookkeeping under `pi.*`, which the storage layer drops on replay by design. Both are the
 * user's conversations, so both have to come back: the store maps the old words and writes
 * the file back in its schema once, the journal replays its entries into the same transcript
 * and tip, and a directory that only has a journal is adopted from what the journal remembers.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { FileSessionStore, JOURNAL_FILE, META_FILE } from "../src/file-store";
import { SessionManager } from "../src/manager";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eta-legacy-"));
  roots.push(root);
  return root;
}

/** The old host's meta.json: `personaId`/`modelId`, and no `id` — the directory was the id. */
const OLD_META = JSON.stringify({
  personaId: "Thinker",
  cwd: "/Users/nut/Desktop/eta",
  modelId: "anthropic:claude-sonnet-4-5",
  createdAt: 1_789_357_345_597,
});

/** The old host's journal: `pi.*` bookkeeping, entries with no sequence, one line per commit. */
const OLD_JOURNAL = `${[
  {
    w: [
      {
        kind: "value",
        op: "set",
        namespace: "pi.branch.tip",
        key: "main",
        value: null,
      },
      {
        kind: "value",
        op: "set",
        namespace: "pi.lane.config",
        key: "main",
        value: {
          model: {
            provider: "pro6000",
            modelId: "qwen3.8-flash-next-uncensored",
          },
          thinkingLevel: "off",
          activeToolNames: [],
        },
      },
    ],
    t: 1_789_357_345_604,
  },
  {
    w: [
      {
        kind: "entry",
        entry: {
          id: "entry-user",
          parentId: null,
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "hi" }],
            timestamp: 1_789_357_426_453,
          },
        },
      },
      {
        kind: "value",
        op: "set",
        namespace: "pi.branch.tip",
        key: "main",
        value: "entry-user",
      },
    ],
    t: 1_789_357_426_453,
  },
  {
    w: [
      {
        kind: "entry",
        entry: {
          id: "entry-reply",
          parentId: "entry-user",
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "hello from the old host" }],
            timestamp: 1_789_357_427_000,
          },
        },
      },
      {
        kind: "value",
        op: "set",
        namespace: "pi.branch.tip",
        key: "main",
        value: "entry-reply",
      },
    ],
    t: 1_789_357_427_000,
  },
]
  .map((line) => JSON.stringify(line))
  .join("\n")}\n`;

/** A session directory as the old host laid it out. */
async function oldSession(root: string, id: string): Promise<string> {
  const directory = join(root, id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, META_FILE), OLD_META, "utf8");
  await writeFile(join(directory, JOURNAL_FILE), OLD_JOURNAL, "utf8");
  return directory;
}

describe("a session the old host wrote", () => {
  it("is listed under its old metadata, which is rewritten in this schema once", async () => {
    const root = await tempRoot();
    const directory = await oldSession(root, "eta-old");
    const warnings: string[] = [];
    const store = new FileSessionStore({
      root,
      warn: (message) => warnings.push(message),
    });

    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.ok).toBe(true);
    // Every word maps: the directory is the id, the card and the model keep their values.
    expect(listed[0]?.ok === true ? listed[0].meta : undefined).toEqual({
      id: "eta-old",
      createdAt: 1_789_357_345_597,
      cwd: "/Users/nut/Desktop/eta",
      persona: "Thinker",
      model: "anthropic:claude-sonnet-4-5",
    });

    // The file on disk is now in this store's schema — written once, and never again.
    const rewritten = JSON.parse(
      await readFile(join(directory, META_FILE), "utf8"),
    ) as Record<string, unknown>;
    expect(rewritten).toMatchObject({
      id: "eta-old",
      persona: "Thinker",
      model: "anthropic:claude-sonnet-4-5",
    });
    expect(rewritten.personaId).toBeUndefined();
    expect(warnings.join(" ")).toContain("eta-old");

    const before = warnings.length;
    await store.list();
    expect(warnings.length).toBe(before);
    await store.close();
  });

  it("replays its journal: the transcript and the tip come back, bookkeeping dropped", async () => {
    const root = await tempRoot();
    await oldSession(root, "eta-old");
    const store = new FileSessionStore({ root });
    const manager = new SessionManager({
      store,
      modelsFor: () => fakeModels([assistantMessage()]) as never,
      // The cards come from discovery in the app; the built-ins answer `Thinker` here.
      personasFor: async () => [
        {
          id: "Thinker",
          name: "Thinker",
          content: "# Thinker\nThink first.\n",
        },
      ],
    });

    const managed = await manager.session("eta-old");
    expect(managed?.meta.persona).toBe("Thinker");
    // The model the old meta named is the model the session runs on.
    expect(managed?.session.kernel.config.get().model).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });

    // The old entries replay as the transcript they always were, on the branch they left.
    const transcript = managed?.session.transcript ?? [];
    const said = (message: { content?: unknown }): string =>
      Array.isArray(message.content)
        ? message.content
            .map((part) => (part as { text?: string }).text ?? "")
            .join("")
        : "";
    expect(transcript.map((message) => said(message as never))).toEqual([
      "hi",
      "hello from the old host",
    ]);
    // The tip is rebuilt from the entries: the `pi.branch.tip` that pointed at it is
    // machinery the storage layer drops on purpose.
    expect(managed?.session.log.graph.tipId()).toBe("entry-reply");

    await manager.closeAll();
    await store.close();
  });
});

describe("a directory with a journal and no meta.json", () => {
  it("is adopted from what the journal remembers, and says so out loud", async () => {
    const root = await tempRoot();
    const directory = join(root, "eta-bare");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, JOURNAL_FILE), OLD_JOURNAL, "utf8");

    const warnings: string[] = [];
    const store = new FileSessionStore({
      root,
      warn: (message) => warnings.push(message),
      fallbackCwd: "/the/folder/nobody/chose",
    });
    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.ok).toBe(true);
    expect(listed[0]?.ok === true ? listed[0].meta : undefined).toEqual({
      id: "eta-bare",
      // The clock the old host wrote on its first line, not the directory's own mtime.
      createdAt: 1_789_357_345_604,
      // Nothing on disk records the folder: the fallback is used and is not a secret.
      cwd: "/the/folder/nobody/chose",
      model: "pro6000:qwen3.8-flash-next-uncensored",
    });
    expect(warnings.join(" ")).toContain(
      "working folder: /the/folder/nobody/chose",
    );

    // And the recovery is written down, so the next read is an ordinary read.
    const adopted = JSON.parse(
      await readFile(join(directory, META_FILE), "utf8"),
    ) as Record<string, unknown>;
    expect(adopted).toMatchObject({
      id: "eta-bare",
      createdAt: 1_789_357_345_604,
      cwd: "/the/folder/nobody/chose",
    });

    const opened = await store.open("eta-bare");
    expect(opened?.meta).toEqual(
      listed[0]?.ok === true ? listed[0].meta : undefined,
    );
    await store.close();
  });
});
