import type { SkillFileArgs, SkillFileResults } from "@eta/client-contracts";
import { Buffer } from "node:buffer";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SkillFiles } from "../src/skill-files";
let home: string, files: SkillFiles;
const text = "---\ndescription: fixture\n---\n";
async function call<A extends keyof SkillFileArgs>(
  action: A,
  args: SkillFileArgs[A],
): Promise<SkillFileResults[A]> {
  return (await files.execute({
    action,
    args,
    location: { home, scope: "personal" },
  } as Parameters<SkillFiles["execute"]>[0])) as SkillFileResults[A];
}
async function setup() {
  await call("create", { skill: "demo", text });
  return call("open", { skill: "demo" });
}
function image(bytes: number, width = 4000, height = 5000) {
  const data = Buffer.alloc(bytes);
  data.set([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);
  data.writeUInt32BE(13, 8);
  data.write("IHDR", 12);
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "eta-skill-limit-")));
  files = new SkillFiles(home);
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
it("accepts exactly 1MiB text, rejects +1 before read/edit/create and preserves plain HTML/SVG", async () => {
  const { detail } = await setup();
  const skill = join(home, ".agents/skills/demo");
  const exact = text + "x".repeat(1048576 - Buffer.byteLength(text));
  await call("create", { skill: "exact", text: exact });
  await expect(
    call("create", { skill: "over", text: `${exact}x` }),
  ).rejects.toThrow("text_limit");
  await writeFile(join(skill, "a.txt"), "x".repeat(1048576));
  expect(await call("read", { detail, path: "a.txt" })).toMatchObject({
    kind: "text",
    size: 1048576,
  });
  await writeFile(join(skill, "a.txt"), "x".repeat(1048577));
  await expect(call("read", { detail, path: "a.txt" })).rejects.toThrow(
    "byte_limit",
  );
  for (const path of ["a.html", "a.svg"]) {
    await writeFile(
      join(skill, path),
      "<script>fetch('https://example.com')</script>",
    );
    expect(await call("read", { detail, path })).toMatchObject({
      kind: "text",
    });
  }
  await writeFile(join(skill, "binary"), Buffer.from([255, 254]));
  expect(await call("read", { detail, path: "binary" })).toMatchObject({
    kind: "unsupported",
  });
});
it("checks signature, exact 3MiB/20M pixels, +1 and aggregate detail budget", async () => {
  const { detail } = await setup();
  const skill = join(home, ".agents/skills/demo");
  await writeFile(join(skill, "exact.png"), image(3145728));
  expect(await call("read", { detail, path: "exact.png" })).toMatchObject({
    kind: "image",
    size: 3145728,
    width: 4000,
    height: 5000,
  });
  // repeat same immutable resource is not an additional retained allocation
  expect((await call("read", { detail, path: "exact.png" })).kind).toBe(
    "image",
  );
  await writeFile(join(skill, "small.png"), image(100));
  await expect(call("read", { detail, path: "small.png" })).rejects.toThrow(
    "image_total_limit",
  );
  await call("close", { detail });
  const fresh = await call("open", { skill: "demo" });
  expect(
    (await call("read", { detail: fresh.detail, path: "small.png" })).kind,
  ).toBe("image");
  await writeFile(join(skill, "over.png"), image(3145729));
  await expect(
    call("read", { detail: fresh.detail, path: "over.png" }),
  ).rejects.toThrow("byte_limit");
  await writeFile(join(skill, "pixels.png"), image(100, 1, 20000001));
  await expect(
    call("read", { detail: fresh.detail, path: "pixels.png" }),
  ).rejects.toThrow("pixel_limit");
  await writeFile(join(skill, "fake.png"), "<svg><script/></svg>");
  expect(
    await call("read", { detail: fresh.detail, path: "fake.png" }),
  ).toMatchObject({ kind: "text" });
});
it("paginates 200, enforces cumulative 2000 and complete delete manifest bounds", async () => {
  const { detail } = await setup();
  const skill = join(home, ".agents/skills/demo");
  await Promise.all(
    Array.from({ length: 1999 }, (_, i) => writeFile(join(skill, `f${i}`), "")),
  );
  let offset: number | null = 0;
  let total = 0;
  do {
    const p: SkillFileResults["directory"] = await call("directory", {
      detail,
      path: "",
      offset,
    });
    expect(p.entries.length).toBeLessThanOrEqual(200);
    total += p.entries.length;
    offset = p.next;
  } while (offset !== null);
  expect(total).toBe(2000);
  expect((await call("planDelete", { skill: "demo" })).count).toBe(2000);
  await writeFile(join(skill, "one-more"), "");
  await expect(call("planDelete", { skill: "demo" })).rejects.toThrow(
    "delete_budget",
  );
  await expect(
    call("directory", { detail, path: "", offset: 2000 }),
  ).rejects.toThrow("entry_limit");
});
it("permits path depth8 but not expansion below8 or delete members at9", async () => {
  const { detail } = await setup();
  const skill = join(home, ".agents/skills/demo");
  const nested = Array.from({ length: 7 }).fill("d").join("/");
  await mkdir(join(skill, nested), { recursive: true });
  await writeFile(join(skill, nested, "eight"), "ok");
  expect((await call("read", { detail, path: `${nested}/eight` })).kind).toBe(
    "text",
  );
  await call("planDelete", { skill: "demo" });
  await mkdir(join(skill, nested, "eight-dir"));
  await expect(
    call("directory", { detail, path: `${nested}/eight-dir` }),
  ).rejects.toThrow("depth_limit");
  await writeFile(join(skill, nested, "eight-dir/nine"), "no");
  await expect(
    call("read", { detail, path: `${nested}/eight-dir/nine` }),
  ).rejects.toThrow("depth_limit");
  await expect(call("planDelete", { skill: "demo" })).rejects.toThrow(
    "delete_budget",
  );
});
it("permission failures are not empty lists and read-only documents cannot be saved", async () => {
  const { detail } = await setup();
  const skill = join(home, ".agents/skills/demo");
  const path = join(skill, "SKILL.md");
  const doc = await call("read", { detail, path: "SKILL.md" });
  if (doc.kind !== "text") throw new Error("expected text content");
  await chmod(path, 0o444);
  try {
    await expect(
      call("save", { skill: "demo", text, version: doc.version }),
    ).rejects.toThrow(/EACCES|EPERM/);
  } finally {
    await chmod(path, 0o644);
  }
  await chmod(join(home, ".agents/skills"), 0);
  try {
    await expect(call("list", {})).rejects.toThrow(/EACCES|EPERM/);
  } finally {
    await chmod(join(home, ".agents/skills"), 0o755);
  }
});
