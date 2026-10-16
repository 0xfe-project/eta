import type { KernelModels } from "@eta/core";
import type { FakeModels } from "@eta/core/testing";
import type { Host } from "./host";
/**
 * One command that walks the whole chain (REFACTOR.md §9, P0.9).
 *
 *   bun run smoke           this machine's own config, and a real model
 *   bun run smoke --fake    a scripted model: no credentials, so CI can run it
 *
 * The chain: create a session → ask it to run a command with the `bash` tool → the answer says
 * what the command printed and the transcript holds the tool result → the host stops → a new
 * host on the same data directory still has the conversation, and can go on with it.
 *
 * The last leg is asserted two different ways on purpose. With a real model, the second question
 * is answered from what the first turn learned. With the scripted one, the proof is stronger and
 * more direct: the request the fake was handed after the restart still carries the earlier tool
 * result, which is exactly the claim "the journal is the conversation".
 */
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { assembleHost } from "./host";

const MARK = "pong-from-smoke";
const fake = process.argv.includes("--fake");
const configPath =
  process.env.ETA_SMOKE_CONFIG ?? join(homedir(), ".eta", "config.json");
const keep = process.argv.includes("--keep");

const failures: string[] = [];
const check = (what: string, ok: boolean, detail = ""): void => {
  if (ok) {
    process.stdout.write(`  ok    ${what}\n`);
    return;
  }
  failures.push(what);
  process.stdout.write(
    `  FAIL  ${what}${detail.length > 0 ? ` — ${detail}` : ""}\n`,
  );
};

const scriptFor = (): KernelModels => {
  const scripted: FakeModels = fakeModels([
    assistantMessage({
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall",
          id: "c1",
          name: "bash",
          arguments: { command: `echo ${MARK}` },
        },
      ],
    }),
    assistantMessage({ content: [{ type: "text", text: MARK }] }),
    assistantMessage({
      content: [{ type: "text", text: `the command printed ${MARK}` }],
    }),
  ]);
  return scripted;
};

interface Turn {
  status: string;
  turns: number;
  text: string;
}

interface Messages {
  meta: { id: string; model?: string };
  messages: { role: string; text: string }[];
}

async function talk(
  host: Host,
  path: string,
  body: unknown,
): Promise<Response> {
  return await fetch(`http://127.0.0.1:${host.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const read = async <T>(response: Response): Promise<T> =>
  (await response.json()) as T;

async function main(): Promise<void> {
  const dataDir = await mkdtemp(
    join(process.env.TMPDIR ?? "/tmp", "eta-smoke-"),
  );
  process.stdout.write(
    `[smoke] ${fake ? "scripted model" : `config ${configPath}`}, data dir ${dataDir}\n`,
  );

  // 1. A host, a session, one turn that has to use the tool.
  const first = await assembleHost({
    dataDir,
    configPath,
    port: 0,
    models: fake ? scriptFor() : undefined,
    warn: (message) => process.stdout.write(`  warn  ${message}\n`),
  });
  check("the host came up", first.port > 0);
  if (!fake)
    check(
      "the config names a model",
      first.models !== undefined,
      "no providers configured",
    );

  const created = await talk(first, "/sessions", {
    title: "smoke",
    cwd: dataDir,
  });
  check(
    "POST /sessions answered 201",
    created.status === 201,
    `got ${created.status}`,
  );
  const session = await read<Messages>(created);
  const id = session.meta.id;

  const prompted = await talk(first, `/sessions/${id}/prompt`, {
    text: `用 bash 工具执行 echo ${MARK},然后只回答命令的输出。`,
  });
  const turn = await read<Turn>(prompted);
  check(
    "the run completed",
    prompted.status === 200 && turn.status === "completed",
    JSON.stringify(turn),
  );
  check(
    "the model answered",
    turn.text.includes(MARK),
    JSON.stringify(turn.text),
  );
  if (!fake)
    check(
      "the run took more than one turn (it used a tool)",
      turn.turns >= 2,
      `turns=${turn.turns}`,
    );

  const after = await read<Messages>(
    await fetch(`http://127.0.0.1:${first.port}/sessions/${id}/messages`),
  );
  const toolResult = after.messages.find(
    (message) => message.role === "toolResult",
  );
  check(
    "the transcript holds the tool result",
    toolResult?.text.includes(MARK) === true,
    JSON.stringify(toolResult),
  );
  check(
    "the transcript is user → … → assistant",
    after.messages[0]?.role === "user" &&
      after.messages.at(-1)?.role === "assistant",
  );

  await first.close();

  // 2. A new host on the same data directory: nothing was carried over in memory.
  const second = await assembleHost({
    dataDir,
    configPath,
    port: 0,
    models: fake ? scriptFor() : undefined,
    warn: () => undefined,
  });
  const replayed = await read<Messages>(
    await fetch(`http://127.0.0.1:${second.port}/sessions/${id}/messages`),
  );
  check("the session survived the restart", replayed.meta.id === id);
  check(
    "its history came back from the journal",
    replayed.messages.some(
      (message) => message.role === "toolResult" && message.text.includes(MARK),
    ),
    JSON.stringify(replayed.messages.map((message) => message.role)),
  );

  // 3. And the conversation can go on.
  const again = await talk(second, `/sessions/${id}/prompt`, {
    text: "刚才那条命令输出的是什么?",
  });
  const turn2 = await read<Turn>(again);
  check(
    "a second turn ran after the restart",
    again.status === 200 && turn2.status === "completed",
    JSON.stringify(turn2),
  );
  if (fake) {
    const calls = (second.models as FakeModels | undefined)?.calls ?? [];
    const carried = JSON.stringify(
      calls.at(-1)?.context.messages ?? [],
    ).includes(MARK);
    check("the replayed history reached the provider", carried);
  } else {
    check(
      "the model remembered what the command printed",
      turn2.text.includes(MARK),
      JSON.stringify(turn2.text),
    );
  }

  await second.close();
  if (!keep) await rm(dataDir, { recursive: true, force: true });
  else process.stdout.write(`[smoke] kept ${dataDir}\n`);

  if (failures.length > 0) {
    process.stdout.write(
      `\n[smoke] ${failures.length} check(s) failed: ${failures.join("; ")}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write("\n[smoke] the whole chain works.\n");
}

main().catch((error: unknown) => {
  console.error(`[smoke] ${String(error)}`);
  process.exit(1);
});
