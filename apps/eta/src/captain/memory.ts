import type { MemoryView } from "@eta/client-contracts";
import type { Database } from "bun:sqlite";
import type { AgentStore } from "../agents/store";
import type { ConversationStore } from "../conversations/store";
import type { MemoryClient } from "../memory/client";
import type { ProjectStore } from "../projects/store";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { agentHome } from "../agents/store";

export interface CaptainMemoryItem {
  id: string;
  agentId: string;
  text: string;
  source: string | null;
  conversationId: string | null;
  path: string | null;
  section: string | null;
  deletedAt: number | null;
}

interface FileEntry {
  id: string;
  text: string;
  section: string;
  path: string;
}

const SECTIONS = ["decision", "preference", "lesson"] as const;
const hash = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 12);
const archiveId = (agentId: string, memoryId: string): string =>
  `${agentId}:${memoryId}`;

function parseFile(path: string, text: string): FileEntry[] {
  const out: FileEntry[] = [];
  let section = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) {
      section = line.slice(3).trim();
      continue;
    }
    if (!SECTIONS.includes(section as (typeof SECTIONS)[number])) continue;
    const bullet = line.trimStart();
    if (!bullet.startsWith("- ")) continue;
    let body = bullet.slice(2).trim();
    const tag = /^\[[^\]]+\]\s+/.exec(body);
    if (tag !== null) body = body.slice(tag[0].length).trim();
    if (body === "") continue;
    out.push({
      id: `file:${hash(`${path}\0${section}\0${body}`)}`,
      text: body,
      section,
      path,
    });
  }
  return out;
}

function renderFile(entries: readonly FileEntry[]): string {
  return [
    "# eta memory (untrusted)",
    ...SECTIONS.flatMap((section) => [
      `## ${section}`,
      ...entries
        .filter((entry) => entry.section === section)
        .map((entry) => `- ${entry.text}`),
    ]),
    "",
  ].join("\n");
}

export class CaptainMemory {
  readonly #db: Database;
  readonly #dataDir: string;
  readonly #agents: AgentStore;
  readonly #projects: ProjectStore;
  readonly #conversations: ConversationStore;
  readonly #client: MemoryClient | undefined;

  constructor(options: {
    db: Database;
    dataDir?: string | undefined;
    /** Kept for callers that used the earlier name; dataDir is the correct root. */
    home?: string | undefined;
    agents: AgentStore;
    projects: ProjectStore;
    conversations: ConversationStore;
    client?: MemoryClient | undefined;
  }) {
    this.#db = options.db;
    this.#dataDir = options.dataDir ?? options.home ?? "";
    this.#agents = options.agents;
    this.#projects = options.projects;
    this.#conversations = options.conversations;
    this.#client = options.client;
  }

  async list(
    agentId: string,
    options: { query?: string; includeDeleted?: boolean } = {},
  ): Promise<CaptainMemoryItem[]> {
    if (this.#agents.get(agentId) === undefined)
      throw new Error(`no such agent: ${agentId}`);
    const sidecar =
      this.#client === undefined
        ? []
        : await this.#client
            .list(agentId, {
              ...(options.query === undefined ? {} : { query: options.query }),
              ...(options.includeDeleted === true
                ? { includeDeleted: true }
                : {}),
            })
            .then((items) =>
              items.map(
                (item: MemoryView): CaptainMemoryItem => ({
                  id: item.id,
                  agentId,
                  text: item.text,
                  source: item.source,
                  conversationId: item.conversationId,
                  path: null,
                  section: null,
                  deletedAt: item.deletedAt,
                }),
              ),
            );
    const files = await this.#files(agentId);
    const query = options.query?.trim().toLowerCase() ?? "";
    const archived = options.includeDeleted ? this.#archived(agentId) : [];
    return [...sidecar, ...files, ...archived].filter(
      (item) => query === "" || item.text.toLowerCase().includes(query),
    );
  }

  async softDelete(agentId: string, id: string, actorAgentId: string) {
    const all = await this.list(agentId, { includeDeleted: false });
    const item = all.find((entry) => entry.id === id);
    if (item === undefined) throw new Error("no such memory");
    if (item.path === null) {
      if (this.#client === undefined)
        throw new Error("memory service is not configured");
      await this.#client.softDelete(agentId, id, actorAgentId);
      return;
    }
    const entries = parseFile(
      item.path,
      await readFile(item.path, "utf8").catch(() => ""),
    );
    const kept = entries.filter((entry) => entry.id !== id);
    if (kept.length === entries.length) throw new Error("no such memory");
    const now = Date.now();
    await this.#db.transaction(() => {
      this.#db
        .query(
          `INSERT INTO captain_memory_archive
             (id, agent_id, path, section, text, deleted_by, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             agent_id = excluded.agent_id,
             path = excluded.path,
             section = excluded.section,
             text = excluded.text,
             deleted_by = excluded.deleted_by,
             deleted_at = excluded.deleted_at,
             restored_at = NULL`,
        )
        .run(
          archiveId(agentId, id),
          agentId,
          item.path,
          item.section ?? "lesson",
          item.text,
          actorAgentId,
          now,
        );
    })();
    await atomicWrite(item.path, renderFile(kept));
  }

  async restore(agentId: string, id: string) {
    const row = this.#db
      .query<
        {
          id: string;
          path: string;
          section: string;
          text: string;
          restored_at: number | null;
        },
        [string, string, string]
      >(
        `SELECT id, path, section, text, restored_at
           FROM captain_memory_archive
          WHERE id = ? AND agent_id = ?`,
      )
      .get(archiveId(agentId, id), id, agentId);
    if (row !== null) {
      if (row.restored_at !== null) return;
      const entries = parseFile(
        row.path,
        await readFile(row.path, "utf8").catch(() => ""),
      );
      entries.push({
        id: row.id.includes(":")
          ? row.id.slice(row.id.indexOf(":") + 1)
          : row.id,
        text: row.text,
        section: row.section,
        path: row.path,
      });
      await atomicWrite(row.path, renderFile(entries));
      this.#db
        .query(
          "UPDATE captain_memory_archive SET restored_at = ? WHERE id = ? AND agent_id = ?",
        )
        .run(Date.now(), archiveId(agentId, id), agentId);
      return;
    }
    if (this.#client === undefined) throw new Error("no such memory");
    await this.#client.restore(agentId, id);
  }

  async #files(agentId: string): Promise<CaptainMemoryItem[]> {
    const paths = new Map<string, "agent" | "project">();
    const agent = this.#agents.get(agentId);
    if (agent !== undefined)
      paths.set(
        join(agentHome(this.#dataDir, agentId), ".eta", "MEMORY.md"),
        "agent",
      );
    for (const project of this.#projects.list()) {
      if (project.kind === "agent_home" && project.stewardId === agentId)
        paths.set(join(project.path, ".eta", "MEMORY.md"), "agent");
      const used = this.#conversations
        .list()
        .some(
          (conversation) =>
            conversation.projectId === project.id &&
            this.#conversations
              .participants(conversation.id)
              .some((participant) => participant.agentId === agentId),
        );
      if (used && !paths.has(join(project.path, ".eta", "MEMORY.md")))
        paths.set(join(project.path, ".eta", "MEMORY.md"), "project");
    }
    const items: CaptainMemoryItem[] = [];
    for (const [path, source] of paths) {
      const text = await readFile(path, "utf8").catch(() => undefined);
      if (text === undefined) continue;
      for (const entry of parseFile(path, text))
        items.push({
          id: entry.id,
          agentId,
          text: entry.text,
          source,
          conversationId: null,
          path,
          section: entry.section,
          deletedAt: null,
        });
    }
    return items;
  }

  #archived(agentId: string): CaptainMemoryItem[] {
    return this.#db
      .query<
        {
          id: string;
          path: string;
          section: string;
          text: string;
          deleted_at: number;
        },
        [string]
      >(
        `SELECT id, path, section, text, deleted_at
           FROM captain_memory_archive
          WHERE agent_id = ? AND restored_at IS NULL
          ORDER BY deleted_at DESC`,
      )
      .all(agentId)
      .map((row) => ({
        id: row.id.includes(":")
          ? row.id.slice(row.id.indexOf(":") + 1)
          : row.id,
        agentId,
        text: row.text,
        source: "project",
        conversationId: null,
        path: row.path,
        section: row.section,
        deletedAt: row.deleted_at,
      }));
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
