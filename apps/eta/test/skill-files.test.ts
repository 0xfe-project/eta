import type {
  MachineView,
  SkillFileArgs,
  SkillFileResults,
  SkillTarget,
} from "@eta/client-contracts";
import { readFile, realpath, stat } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";
import { Places } from "@eta/places";
import { expect, it } from "vitest";
import { until } from "./support/client";
import { approve, dropLink, machineView, startDaemon } from "./support/daemon";
import { tempDir } from "./support/host";
import { world } from "./support/world";

const text = "---\ndescription: fixture only\n---\n";
it("routes primary and real daemon svc into distinct isolated project files and rejects stale epochs/offline targets", async () => {
  const w = await world();
  const primary = w.client
    .section<MachineView[]>("machines", "list")!
    .find((m) => m.kind === "primary")!;
  const daemonHome = await realpath(await tempDir("skill-daemon-home-"));
  const daemon = await startDaemon(w.host, w.client, {
    node: { places: new Places({ home: daemonHome, os: platform() }) },
  });
  await approve(w.client, daemon);
  await until(
    () => machineView(w.client, daemon.machineId)?.home === daemonHome,
  );
  const remote = machineView(w.client, daemon.machineId)!;
  const a = await w.project({
    path: await tempDir("skill-primary-"),
    machineId: primary.id,
  });
  const b = await w.project({
    path: await tempDir("skill-daemon-"),
    machineId: remote.id,
  });
  const call = async <A extends keyof SkillFileArgs>(
    action: A,
    target: SkillTarget,
    input: SkillFileArgs[A],
  ) =>
    (await w.client.call("skills", action, { target, input })) as {
      target: SkillTarget;
      result: SkillFileResults[A];
    };
  const target = (m: MachineView, p: typeof a): SkillTarget => ({
    machineId: m.id,
    home: m.home!,
    scope: "project",
    projectId: p.id,
  });
  const ta = (await call("list", target(primary, a), {})).target;
  const tb = (await call("list", target(remote, b), {})).target;
  await call("create", ta, { skill: "demo", text: `${text}PRIMARY` });
  await call("create", tb, { skill: "demo", text: `${text}DAEMON` });
  expect(
    await readFile(join(a.path, ".agents/skills/demo/SKILL.md"), "utf8"),
  ).toContain("PRIMARY");
  expect(
    await readFile(join(b.path, ".agents/skills/demo/SKILL.md"), "utf8"),
  ).toContain("DAEMON");
  const opened = await call("open", tb, { skill: "demo" });
  expect(
    await call("read", tb, { detail: opened.result.detail, path: "SKILL.md" }),
  ).toMatchObject({ result: { kind: "text", text: `${text}DAEMON` } });
  await expect(
    call("open", { ...tb, projectId: a.id }, { skill: "demo" }),
  ).rejects.toThrow("project_machine_mismatch");
  await expect(
    call("open", { ...tb, projectPath: a.path }, { skill: "demo" }),
  ).rejects.toThrow("project_changed");
  await expect(
    call("list", { ...tb, home: "/not-the-daemon-home" }, {}),
  ).rejects.toThrow("home_changed");
  await dropLink(w.host, w.client, daemon);
  await expect(
    call("save", tb, { skill: "demo", text, version: "old" }),
  ).rejects.toThrow("target_changed");
  const fresh = (await call("list", tb, {})).target;
  const plan = await call("planDelete", fresh, { skill: "demo" });
  await call("delete", fresh, { skill: "demo", version: plan.result.version });
  expect(
    await stat(join(a.path, ".agents/skills/demo/SKILL.md")),
  ).toBeDefined();
  await daemon.link.stop();
  await expect(call("create", fresh, { skill: "never", text })).rejects.toThrow(
    /offline/,
  );
}, 30_000);
