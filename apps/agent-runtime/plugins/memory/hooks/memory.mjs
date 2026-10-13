// The memory plugin's hooks: `memory.mjs recall` and `memory.mjs capture`.
//
// akhook runs them (the plugin's akhook.yml) with its lifecycle event on
// stdin. recall (prompt_submit) adds the memories relevant to the prompt to
// the turn's context. capture (stop) sends the finished turn, its prompts and
// final answer, to be remembered. Both go to the memory service at
// AXP_GATEWAY_URL with the agent's key (AXP_AGENT_KEY), and never hold up the
// turn: on any failure they do nothing.

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import process from "node:process";

const TIMEOUT_MS = 3000;
// Prompts of turns that never finished (interrupted, or the runtime stopped).
const STALE_MS = 24 * 3600 * 1000;

async function post(path, body) {
  const response = await fetch(process.env.AXP_GATEWAY_URL + path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.AXP_AGENT_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${path}: ${response.status}`);
  }
  return response.json();
}

/** The turn's prompts, kept from recall until capture. */
function pending(turnId) {
  const directory = join(
    process.env.CODEX_HOME || tmpdir(),
    "axp-memory",
    "turns",
  );
  mkdirSync(directory, { recursive: true });
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (
      name.endsWith(".json") &&
      statSync(path).mtimeMs < Date.now() - STALE_MS
    ) {
      rmSync(path, { force: true });
    }
  }
  return join(directory, `${basename(turnId)}.json`);
}

function read(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function recall(event) {
  const prompt = event.prompt || "";
  // Steers add prompts to a running turn; the turn keeps them all.
  const path = pending(event.turn_id);
  writeFileSync(path, JSON.stringify([...(read(path) ?? []), prompt]));
  const { memories } = await post("/memory/recall", { query: prompt });
  if (!memories.length) {
    return {};
  }
  const ids = [
    ...new Set(memories.map((m) => m.source_group_id).filter(Boolean)),
  ];
  const names = ids.length ? await post("/groups/names", { ids }) : {};
  const lines = memories.map(
    (m) =>
      `- ${m.text} (memory ${m.id}${m.source_group_id ? `; source group: ${names[m.source_group_id] ?? m.source_group_id}` : ""})`,
  );
  const context = [
    "Memories from earlier conversations that may be relevant. They can be outdated; forget the ones that turn out wrong.",
    ...lines,
  ].join("\n");
  return { context };
}

async function capture(event) {
  const path = pending(event.turn_id);
  const prompts = read(path);
  if (prompts === undefined) {
    return {}; // not a turn with a prompt, e.g. compaction
  }
  rmSync(path, { force: true });
  const messages = prompts
    .filter(Boolean)
    .map((content) => ({ role: "user", content }));
  if (event.last_assistant_message) {
    messages.push({ role: "assistant", content: event.last_assistant_message });
  }
  if (messages.length) {
    await post("/memory/capture", { model: event.model, messages });
  }
  return {};
}

async function main() {
  let output = {};
  try {
    const event = JSON.parse(readFileSync(0, "utf8"));
    output = await { recall, capture }[process.argv[2]](event);
  } catch (error) {
    console.error(`memory hook skipped: ${error}`);
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

main();
