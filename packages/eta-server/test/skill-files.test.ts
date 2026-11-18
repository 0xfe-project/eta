import type {
  SkillFileArgs,
  SkillFileLocation,
  SkillFileResults,
} from "@eta/client-contracts";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillFiles } from "../src/skill-files";

let home: string, files: SkillFiles, location: SkillFileLocation;
const raw =
  "---\r\nname: demo\r\ndescription: works\r\n# preserve me\r\nunknown: [1, 2]\r\n---\r\n\r\nHello\r\n";
async function call<A extends keyof SkillFileArgs>(
  action: A,
  args: SkillFileArgs[A],
): Promise<SkillFileResults[A]> {
  return (await files.execute({ action, args, location } as Parameters<
    SkillFiles["execute"]
  >[0])) as SkillFileResults[A];
}
async function setup() {
  await call("create", { skill: "demo", text: raw });
  return call("open", { skill: "demo" });
}
async function exists(path: string) {
  return stat(path).then(
    () => true,
    () => false,
  );
}
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "eta-skill-files-")));
  files = new SkillFiles(home);
  location = { home, scope: "personal" };
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
describe("skill file management in isolated homes", () => {
  it("distinguishes absent/empty roots and never creates on list", async () => {
    expect(await call("list", {})).toMatchObject({
      exists: false,
      entries: [],
    });
    expect(await exists(join(home, ".agents"))).toBe(false);
    await mkdir(join(home, ".agents/skills"), { recursive: true });
    expect(await call("list", {})).toMatchObject({ exists: true, entries: [] });
  });
  it("keeps raw frontmatter, saves only with current identity/content version", async () => {
    const { detail } = await setup();
    const first = await call("read", { detail, path: "SKILL.md" });
    expect(first.kind).toBe("text");
    if (first.kind !== "text") throw new Error("expected text content");
    expect(first.text).toBe(raw);
    expect(first.preview).toEqual({
      body: "Hello",
      metadata:
        "name: demo\ndescription: works\n# preserve me\nunknown: [1, 2]",
    });
    const next = raw.replace("Hello", "Changed");
    await call("save", { skill: "demo", text: next, version: first.version });
    expect(
      await readFile(join(home, ".agents/skills/demo/SKILL.md"), "utf8"),
    ).toBe(next);
    await expect(
      call("save", { skill: "demo", text: raw, version: first.version }),
    ).rejects.toThrow("conflict");
    await expect(call("create", { skill: "demo", text: raw })).rejects.toThrow(
      "EEXIST",
    );
  });
  it("refuses external edits, delete/recreate, parent identity replacement, and invalid metadata", async () => {
    const { detail } = await setup();
    const first = await call("read", { detail, path: "SKILL.md" });
    if (first.kind !== "text") throw new Error("expected text content");
    const skill = join(home, ".agents/skills/demo");
    const path = join(skill, "SKILL.md");
    await writeFile(path, `${raw}external`);
    await expect(
      call("save", { skill: "demo", text: raw, version: first.version }),
    ).rejects.toThrow("conflict");
    await rm(path);
    await writeFile(path, raw);
    await expect(
      call("save", { skill: "demo", text: raw, version: first.version }),
    ).rejects.toThrow("conflict");
    await rename(skill, `${skill}-old`);
    await mkdir(skill);
    await rename(join(`${skill}-old`, "SKILL.md"), path);
    await expect(call("read", { detail, path: "SKILL.md" })).rejects.toThrow(
      "changed",
    );
    await expect(
      call("create", { skill: "bad", text: "no description" }),
    ).rejects.toThrow("invalid_skill");
    expect(await exists(join(home, ".agents/skills/bad"))).toBe(false);
  });
  it("preserves warning-only validation and broken documents can be read/repaired", async () => {
    const warning = await call("create", { skill: "other", text: raw });
    expect(warning.diagnostics.length).toBeGreaterThan(0);
    await writeFile(
      join(home, ".agents/skills/other/SKILL.md"),
      "---\n[bad yaml\n---\n",
    );
    const { detail } = await call("open", { skill: "other" });
    const broken = await call("read", { detail, path: "SKILL.md" });
    expect(broken.kind).toBe("text");
    if (broken.kind !== "text") throw new Error("expected text content");
    expect(broken.diagnostics.length).toBeGreaterThan(0);
    expect(broken.preview).toBeUndefined();
    expect(broken.text).toBe("---\n[bad yaml\n---\n");
    await call("save", { skill: "other", text: raw, version: broken.version });
  });
  it("rejects traversal, root/internal/outbound/dangling links without affecting unrelated skills", async () => {
    const { detail } = await setup();
    for (const skill of ["..", "/tmp/x", "a/b", "a\\b", "", "CON"])
      await expect(call("create", { skill, text: raw })).rejects.toThrow(
        "invalid_name",
      );
    await expect(
      call("read", { detail, path: "../demo-else/file" }),
    ).rejects.toThrow("outside_skill");
    await symlink(home, join(home, ".agents/skills/demo/link"));
    await expect(call("read", { detail, path: "link/test" })).rejects.toThrow(
      "link_refused",
    );
    await expect(call("planDelete", { skill: "demo" })).rejects.toThrow(
      "link_refused",
    );
    await symlink("missing", join(home, ".agents/skills/dangling"));
    expect(
      (await call("list", {})).entries.find((e) => e.path === "dangling")?.kind,
    ).toBe("blocked");
    expect((await call("read", { detail, path: "SKILL.md" })).kind).toBe(
      "text",
    );
    await rename(join(home, ".agents"), join(home, "original"));
    await symlink(join(home, "original"), join(home, ".agents"));
    await expect(call("list", {})).rejects.toThrow("link_refused");
  });
  it("plans all hidden contents, rejects changed confirmation, and deletes only a skill", async () => {
    await setup();
    const skill = join(home, ".agents/skills/demo");
    await mkdir(join(skill, "nested"));
    await writeFile(join(skill, "nested/.hidden"), "secret");
    const plan = await call("planDelete", { skill: "demo" });
    expect(plan).toMatchObject({
      shared: true,
      irreversible: true,
      count: 3,
      path: skill,
    });
    expect(plan.entries.map((e) => e.path)).toContain("nested/.hidden");
    await writeFile(join(skill, "nested/.hidden"), "changed");
    await expect(
      call("delete", { skill: "demo", version: plan.version }),
    ).rejects.toThrow("conflict_reconfirm");
    expect(await exists(skill)).toBe(true);
    const fresh = await call("planDelete", { skill: "demo" });
    await call("delete", { skill: "demo", version: fresh.version });
    expect(await exists(skill)).toBe(false);
    expect(await exists(join(home, ".agents/skills"))).toBe(true);
    await mkdir(join(home, ".agents/skills/container"));
    await expect(call("planDelete", { skill: "container" })).rejects.toThrow();
  });
  it("binds details to home/project and releases them on close", async () => {
    const { detail } = await setup();
    const project = join(home, "project");
    await mkdir(project);
    location = { home, scope: "project", projectPath: project };
    await call("create", {
      skill: "demo",
      text: raw.replace("Hello", "PROJECT"),
    });
    await expect(call("read", { detail, path: "SKILL.md" })).rejects.toThrow(
      "detail_expired",
    );
    const p = await call("open", { skill: "demo" });
    await call("close", { detail: p.detail });
    await expect(
      call("read", { detail: p.detail, path: "SKILL.md" }),
    ).rejects.toThrow("detail_expired");
    location = { home: `${home}-other`, scope: "personal" };
    await expect(call("list", {})).rejects.toThrow("home_changed");
  });
});
