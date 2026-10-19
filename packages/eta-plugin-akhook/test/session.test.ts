/**
 * The plugin in a session: lifecycle rules around a run, and the streaming rules' record in the
 * journal (an interrupted generation leaves a fact, not text; what fired survives a reopen).
 */
import type { InterruptEntry } from "@eta/core/session";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runner } from "@eta/core";
import { SessionLog } from "@eta/core/session";
import { MemoryStorage } from "@eta/core/storage";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { journaledKernel } from "@eta/harness/testing";
import { afterEach, describe, expect, it } from "vitest";
import { AkhookSession, journalTriggerStore, lifecycleHooks } from "../src";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function projectWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "akhook-session-"));
  dirs.push(root);
  for (const [name, text] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
    if (name.startsWith("hooks/")) chmodSync(path, 0o755);
  }
  return root;
}

const userMsg = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
  timestamp: 0,
});
const say = (text: string) =>
  assistantMessage({ content: [{ type: "text", text }] });

describe("lifecycle rules around a run", () => {
  const files = {
    ".akhook.yml": `version: 1
rules:
  - id: memory/recall
    on: prompt_submit
    run: {argv: [./hooks/recall]}
  - id: memory/capture
    on: stop
    run: {argv: [./hooks/capture]}
`,
    "hooks/recall": `#!/bin/sh\ncat > "$(dirname "$0")/recall.in"\necho '{"context":"you remember: tea"}'\n`,
    "hooks/capture": `#!/bin/sh\ncat > "$(dirname "$0")/capture.in"\n`,
  };

  it("prompt_submit adds its context to the run, and gets the event as versioned JSON", async () => {
    const root = projectWith(files);
    const hooks = lifecycleHooks({ userConfigPath: join(root, "none.yml") });
    const context = await hooks.beforeRun(
      { cwd: root, sessionId: "s1", turnId: "t1", model: "m" },
      "what do I drink?",
    );
    expect(context).toBe("you remember: tea");
    expect(
      JSON.parse(readFileSync(join(root, "hooks/recall.in"), "utf8")),
    ).toEqual({
      version: 1,
      rule_id: "memory/recall",
      event: "prompt_submit",
      cwd: root,
      session_id: "s1",
      turn_id: "t1",
      model: "m",
      prompt: "what do I drink?",
    });
  });

  it("stop receives the last assistant message", async () => {
    const root = projectWith(files);
    const hooks = lifecycleHooks({ userConfigPath: join(root, "none.yml") });
    await hooks.afterRun({ cwd: root, turnId: "t1" }, "tea, as ever");
    expect(
      JSON.parse(readFileSync(join(root, "hooks/capture.in"), "utf8")),
    ).toMatchObject({
      rule_id: "memory/capture",
      event: "stop",
      last_assistant_message: "tea, as ever",
    });
  });

  it("never holds up the agent: a broken command, a broken file, or no rules at all adds nothing", async () => {
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);
    const broken = projectWith({
      ".akhook.yml": files[".akhook.yml"],
      "hooks/recall": "#!/bin/sh\nexit 2\n",
      "hooks/capture": "#!/bin/sh\nexit 2\n",
    });
    const hooks = lifecycleHooks({
      userConfigPath: join(broken, "none.yml"),
      warn,
    });
    expect(await hooks.beforeRun({ cwd: broken }, "hi")).toBeUndefined();
    await expect(
      hooks.afterRun({ cwd: broken }, "bye"),
    ).resolves.toBeUndefined();

    const invalid = projectWith({ ".akhook.yml": "version: [" });
    expect(await hooks.beforeRun({ cwd: invalid }, "hi")).toBeUndefined();
    await expect(
      hooks.afterRun({ cwd: invalid }, "bye"),
    ).resolves.toBeUndefined();

    const empty = projectWith({});
    expect(await hooks.beforeRun({ cwd: empty }, "hi")).toBeUndefined();
    expect(warnings.length).toBeGreaterThanOrEqual(3);
  });

  it("joins the contexts of several rules, and reads the host's additional config", async () => {
    const root = projectWith({
      "hooks/a": `#!/bin/sh\necho '{"context":"first"}'\n`,
      "hooks/b": `#!/bin/sh\necho '{"context":"second"}'\n`,
    });
    const hooks = lifecycleHooks({
      userConfigPath: join(root, "none.yml"),
      additional: () => [
        {
          name: "environment",
          text: `version: 1
rules:
  - {id: a, on: prompt_submit, run: {argv: ["${join(root, "hooks/a")}"]}}
  - {id: b, on: prompt_submit, run: {argv: ["${join(root, "hooks/b")}"]}}
`,
        },
      ],
    });
    expect(await hooks.beforeRun({ cwd: root }, "hi")).toBe("first\n\nsecond");
  });

  it("a session whose project is on another machine has no project layer", async () => {
    const root = projectWith(files);
    const hooks = lifecycleHooks({
      userConfigPath: join(root, "none.yml"),
      fallbackRoot: root,
    });
    // Same files on disk, but the run says its directory is elsewhere: .akhook.yml is not read.
    expect(await hooks.beforeRun({ cwd: undefined }, "hi")).toBeUndefined();
  });
});

describe("the streaming rules in the journal", () => {
  const rules = `version: 1
rules:
  - id: no-secret
    on: stream
    checks: [{regex: 'SECRET'}]
    message: do not say the secret word
`;

  async function open(
    storage: MemoryStorage,
    script: ReturnType<typeof say>[],
  ) {
    const log = await SessionLog.load(storage);
    const { kernel, journaling } = journaledKernel(log, {
      config: { model: { provider: "p", modelId: "m" } },
    });
    const fake = fakeModels(script, { chunkSize: 4 });
    const runner = new Runner(kernel, {
      models: fake,
      journal: journaling,
      initialTranscript: log.transcript(),
    });
    const akhook = new AkhookSession({
      cwd: undefined,
      fallbackRoot: "/project",
      ask: undefined,
      userConfigPath: "/nonexistent/akhook.yml",
      additional: () => [{ name: "t", text: rules }],
      store: journalTriggerStore({ log, journaling }),
    });
    await akhook.attach({ runner, kernel });
    return { log, kernel, runner, akhook, fake };
  }

  it("an interrupted generation is an interrupt entry plus the reminder, never the discarded text", async () => {
    const storage = new MemoryStorage();
    const s = await open(storage, [
      say("the SECRET word is out"),
      say("a clean answer"),
    ]);
    s.kernel.inject(userMsg("go"));
    const result = await s.runner.run();
    expect(result.status).toBe("completed");

    const stored = await storage.scanEntries({});
    expect(JSON.stringify(stored)).not.toContain("SECRET word");
    const interrupts = stored.filter(
      (entry): entry is InterruptEntry => entry.type === "interrupt",
    );
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0]!.payload).toMatchObject({ source: "no-secret" });
    expect(JSON.stringify(stored)).toContain("do not say the secret word");
  });

  it("what fired is saved with the session, so a reopened session does not fire again", async () => {
    const storage = new MemoryStorage();
    const first = await open(storage, [say("SECRET one"), say("clean")]);
    first.kernel.inject(userMsg("go"));
    await first.runner.run();

    const second = await open(storage, [say("SECRET two is fine now")]);
    expect(second.akhook.streams.snapshot().injected).toHaveProperty(
      "no-secret",
    );
    second.kernel.inject(userMsg("again"));
    await second.runner.run();
    expect(
      (await storage.scanEntries({})).filter(
        (entry) => entry.type === "interrupt",
      ),
    ).toHaveLength(1);
    expect(second.fake.calls).toHaveLength(1);
  });
});
