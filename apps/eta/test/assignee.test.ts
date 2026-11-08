/**
 * Assignee resolution: from user-provided name or id to the registry's id.
 *
 * A draft_task or create_task may name the assignee by its name (as the user knows it) or by its
 * UUID. The write paths (tasks/assignee.ts) resolve it to the UUID at write time, before the task
 * is stored, so a task always holds a UUID or null. If the name is nobody's, or more than one
 * agent has it, the task creation fails immediately, with a list of available agents.
 */
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStore } from "../src/agents/store";
import {
  applyMigrations,
  loadMigrations,
  openDatabase,
  statementsOf,
} from "../src/db";
import { resolveAssignee } from "../src/tasks/assignee";

const open: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

describe("resolveAssignee", () => {
  it("resolves an agent by UUID (exact match)", () => {
    const db = openDatabase(":memory:");
    open.push(db);
    applyMigrations(db, loadMigrations());
    const agents = new AgentStore(db);
    const ada = agents.create({ name: "Ada" });
    expect(resolveAssignee(ada.id, agents)).toBe(ada.id);
  });

  it("resolves an agent by name (exact case-sensitive match)", () => {
    const db = openDatabase(":memory:");
    open.push(db);
    applyMigrations(db, loadMigrations());
    const agents = new AgentStore(db);
    const ada = agents.create({ name: "Ada" });
    expect(resolveAssignee("Ada", agents)).toBe(ada.id);
  });

  it("resolves an agent by name case-insensitively as a fallback", () => {
    const db = openDatabase(":memory:");
    open.push(db);
    applyMigrations(db, loadMigrations());
    const agents = new AgentStore(db);
    const ada = agents.create({ name: "Ada" });
    expect(resolveAssignee("ada", agents)).toBe(ada.id);
  });

  it("rejects an assignee that nobody has", () => {
    const db = openDatabase(":memory:");
    open.push(db);
    applyMigrations(db, loadMigrations());
    const agents = new AgentStore(db);
    agents.create({ name: "Ada" });
    expect(() => resolveAssignee("Nobody", agents)).toThrow(
      /no agent is "Nobody"/,
    );
  });

  it("lists available agents in the error message", () => {
    const db = openDatabase(":memory:");
    open.push(db);
    applyMigrations(db, loadMigrations());
    const agents = new AgentStore(db);
    const ada = agents.create({ name: "Ada" });
    const bola = agents.create({ name: "Bola" });
    try {
      resolveAssignee("Charlie", agents);
      expect.fail("should have thrown");
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toContain("Ada");
      expect(msg).toContain("Bola");
      expect(msg).toContain(`Ada (${ada.id})`);
      expect(msg).toContain(`Bola (${bola.id})`);
      expect(msg).toContain('"Charlie"');
    }
  });

  it("rejects an ambiguous name (more than one agent)", () => {
    const db = openDatabase(":memory:");
    open.push(db);
    applyMigrations(db, loadMigrations());
    const agents = new AgentStore(db);
    agents.create({ name: "Ada" });
    agents.create({ name: "Ada" });
    expect(() => resolveAssignee("Ada", agents)).toThrow(
      /more than one agent is called "Ada"/,
    );
  });

  it("treats blank or undefined as no assignee", () => {
    const db = openDatabase(":memory:");
    open.push(db);
    applyMigrations(db, loadMigrations());
    const agents = new AgentStore(db);
    expect(resolveAssignee(undefined, agents)).toBeUndefined();
    expect(resolveAssignee("", agents)).toBeUndefined();
    expect(resolveAssignee("  ", agents)).toBeUndefined();
  });
});

describe("the migration that turns stored assignee names into ids", () => {
  const all = loadMigrations();
  const normalize = all.find((m) => m.id === "0045-normalize-assignee-names")!;

  function before() {
    const db = openDatabase(":memory:");
    open.push(db);
    applyMigrations(
      db,
      all.filter((m) => m.id < normalize.id),
    );
    const agents = new AgentStore(db);
    return { db, agents };
  }

  const task = (db: Database, number: number, assignee: string | null) =>
    db
      .query(
        "INSERT INTO task (id, number, title, status, created_by_agent, assignee_agent, workspace_mode, created_at, updated_at) VALUES (?, ?, ?, 'todo', NULL, ?, 'local', 0, 0)",
      )
      .run(`t${number}`, number, `task ${number}`, assignee);
  const assigneeOf = (db: Database, number: number) =>
    db
      .query<{ assignee_agent: string | null }, [number]>(
        "SELECT assignee_agent FROM task WHERE number = ?",
      )
      .get(number)!.assignee_agent;

  it("resolves a unique name, leaves ids, unknown and ambiguous names alone, and changes nothing a second time", () => {
    const { db, agents } = before();
    const lin = agents.create({ name: "林老师" });
    const ada = agents.create({ name: "Ada" });
    agents.create({ name: "Twin" });
    agents.create({ name: "Twin" });
    task(db, 1, "林老师");
    task(db, 2, ada.id);
    task(db, 3, "ada");
    task(db, 4, "Nobody");
    task(db, 5, "Twin");
    task(db, 6, null);

    expect(applyMigrations(db, [normalize])).toEqual([normalize.id]);
    const after = [1, 2, 3, 4, 5, 6].map((n) => assigneeOf(db, n));
    expect(after).toEqual([lin.id, ada.id, ada.id, "Nobody", "Twin", null]);

    // The statements themselves are idempotent, not only the runner's bookkeeping.
    for (const statement of statementsOf(normalize.sql)) db.exec(statement);
    expect([1, 2, 3, 4, 5, 6].map((n) => assigneeOf(db, n))).toEqual(after);
  });
});
