/** Real native sessions and loader, with scripted model transport (no provider access). */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { expect, it } from "vitest";
import { SessionManager } from "../src/manager";
import { MemorySessionStore } from "../src/memory-store";
import { renderSkillsBlock } from "../src/skills";

it("captures summaries once per native open, while later file reads see edits/deletion and context retains prior reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "eta-skill-lifecycle-"));
  const cwd = join(root, "project");
  const home = join(root, "home");
  const dir = join(cwd, ".agents/skills/lifecycle");
  const file = join(dir, "SKILL.md");
  const original =
    "---\nname: lifecycle\ndescription: ORIGINAL SUMMARY\n---\nORIGINAL BODY\n";
  const changed = original.replaceAll("ORIGINAL", "CHANGED");
  const models = fakeModels(
    Array.from({ length: 7 }, () =>
      assistantMessage({ content: [{ type: "text", text: "ack" }] }),
    ),
  );
  let scans = 0;
  const sessions = new SessionManager({
    store: new MemorySessionStore(),
    modelsFor: () => models,
    skillsFor: async (meta) => {
      scans++;
      return renderSkillsBlock({ cwd: meta.cwd, home });
    },
  });
  const turn = async (
    session: Awaited<ReturnType<typeof sessions.create>>,
    text: string,
  ) => {
    const before = session.session.log.transcript().length;
    session.session.kernel.inject({
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    });
    const deadline = Date.now() + 5000;
    while (session.session.log.transcript().length < before + 2) {
      if (Date.now() > deadline) throw new Error("native turn timed out");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return models.calls.at(-1)!.context;
  };
  try {
    await mkdir(dir, { recursive: true });
    await mkdir(home);
    await writeFile(file, original);
    const old = await sessions.create({ cwd });
    const first = await turn(old, "first");
    expect(first.systemPrompt).toContain("ORIGINAL SUMMARY");
    expect(first.systemPrompt).not.toContain("ORIGINAL BODY");
    // A later actual file read, recorded as already-read context. This is not a model deciding to read.
    await turn(old, await readFile(file, "utf8"));
    await writeFile(file, changed);
    expect(await renderSkillsBlock({ cwd, home })).toContain("CHANGED SUMMARY");
    expect((await sessions.session(old.meta.id))!.session).toBe(old.session);
    const stale = await turn(old, "after management refresh");
    expect(stale.systemPrompt).toContain("ORIGINAL SUMMARY");
    expect(stale.systemPrompt).not.toContain("CHANGED SUMMARY");
    expect(JSON.stringify(stale.messages)).toContain("ORIGINAL BODY");
    expect(await readFile(file, "utf8")).toContain("CHANGED BODY");
    expect(scans).toBe(1);
    const fresh = await sessions.create({ cwd });
    expect((await turn(fresh, "new instance")).systemPrompt).toContain(
      "CHANGED SUMMARY",
    );
    await rm(dir, { recursive: true });
    await expect(readFile(file, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const deleted = await turn(old, "after delete");
    expect(deleted.systemPrompt).toContain("ORIGINAL SUMMARY");
    expect(JSON.stringify(deleted.messages)).toContain("ORIGINAL BODY");
    const after = await sessions.create({ cwd });
    expect((await turn(after, "new after delete")).systemPrompt).not.toContain(
      "<name>lifecycle</name>",
    );
    await sessions.close(old.meta.id);
    const reopened = (await sessions.session(old.meta.id))!;
    expect((await turn(reopened, "reopened")).systemPrompt).not.toContain(
      "<name>lifecycle</name>",
    );
    expect(JSON.stringify(reopened.session.log.transcript())).toContain(
      "ORIGINAL BODY",
    );
    expect(scans).toBe(4);
  } finally {
    await sessions.closeAll();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

it("keeps directory discovery order and duplicate skill names, appending extras without replacing personal or project entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "eta-skill-order-"));
  const home = join(root, "home");
  const project = join(home, "project");
  const extra = join(root, "plugin");
  try {
    for (const [base, description] of [
      [join(project, ".agents/skills"), "PROJECT"],
      [join(home, ".agents/skills"), "PERSONAL"],
      [extra, "PLUGIN"],
    ]) {
      const dir = join(base!, "same");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "SKILL.md"),
        `---\nname: same\ndescription: ${description}\n---\nBODY`,
      );
    }
    const block = await renderSkillsBlock({
      cwd: project,
      home,
      extraDirs: [extra],
    });
    expect(block.split("<name>same</name>").slice(1)).toHaveLength(3);
    expect(block.indexOf("PROJECT")).toBeLessThan(block.indexOf("PERSONAL"));
    expect(block.indexOf("PERSONAL")).toBeLessThan(block.indexOf("PLUGIN"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
