/**
 * The smoke scenario (REFACTOR.md §2.2).
 *
 * One description of what "the kernel works against a real provider" means, so
 * every backend can be held to it without copying the script: stream a real
 * turn, call a real tool, journal it, reload from storage, answer a follow-up
 * from the restored history. The caller supplies the models (real) and the
 * storage (memory or a file); nothing here knows either.
 */

import type { Kernel, KernelModels, KernelTool, Runner } from "@eta/core";
import type { StorageService } from "@eta/core/storage";
import { kernelOn } from "@eta/core";
import { openSession } from "../open";
import { RunPump } from "../pump";

export interface SmokeOptions {
  models: KernelModels;
  provider: string;
  modelId: string;
  storage: StorageService;
  timeoutMs: number;
  /** Where the run's progress goes; defaults to stdout. */
  log?: (line: string) => void;
}

export interface SmokeReport {
  /** What the model recorded through the tool. */
  notes: string[];
  /** Characters the provider streamed as text (proves real deltas arrived). */
  streamedChars: number;
  /** Output counters the provider reported, per settled message. */
  usage: { input: number; output: number; totalTokens: number }[];
  /** The final answer of the first run. */
  firstAnswer: string;
  /** The answer after a reload, which must come from the restored transcript. */
  recalled: string;
  /** Turns the first run counted. */
  turns: number;
  /** Entries on disk after the first run. */
  entries: number;
  /** Events observed, in order of first appearance. */
  events: string[];
  /** Stats the storage rebuilt from the journal. */
  stats: {
    messageCount: number;
    input: number;
    output: number;
    totalTokens: number;
  };
  /** Whether the second open found the configuration the first one left. */
  configRestored: boolean;
}

const PROMPT_REMEMBER = "Please remember the word: kumquat. Then say done.";
const PROMPT_RECALL =
  "What word did I ask you to remember? Answer with just the word.";
/**
 * What is asked when a model answers without calling the tool it was told to call.
 *
 * The scenario is about the mechanism — a tool call that streams, journals and survives a reload —
 * not about a model's willingness on any one turn. A real model occasionally just answers, and a
 * smoke that fails for that reason is a coin flip, not a signal; one nudge costs one turn and puts
 * the question back to the model. If it still will not call the tool, that is worth failing over.
 */
const PROMPT_NUDGE =
  "You did not call the note tool. Call it now, then reply with one short sentence.";

function textsOf(
  messages: readonly { role?: string; content?: unknown }[],
): string {
  return messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) =>
      Array.isArray(message.content)
        ? (message.content as { type?: string; text?: string }[])
            .filter((part) => part.type === "text")
            .map((part) => part.text ?? "")
        : [],
    )
    .join(" ")
    .trim();
}

/** Wait until the pumped run settles, or the timeout expires. */
async function waitForIdle(
  runner: Runner,
  kernel: Kernel,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!runner.running && kernel.inboxDepth === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function runSmokeScenario(
  options: SmokeOptions,
): Promise<SmokeReport> {
  const log = options.log ?? ((line: string) => console.log(line));
  // The same call a host makes for a new session and for a restart: everything
  // below comes back from the journal (empty on the first run).
  const opened = await openSession({
    storage: options.storage,
    models: options.models,
    config: {
      model: { provider: options.provider, modelId: options.modelId },
      activeToolNames: ["note"],
    },
    runner: {
      systemPrompt:
        "A terse test agent. When asked to remember something, call the note tool exactly once, then reply with one short sentence.",
    },
  });
  const { kernel, runner } = opened;

  // A configuration the default does not carry, so the second open proves it
  // came off disk rather than out of this function's arguments.
  kernel.config.update({ thinkingLevel: "low" });
  await opened.journaling.flush();

  const notes: string[] = [];
  const note = {
    name: "note",
    description:
      "Record a short note. Call this exactly once when asked to remember something.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "the note to record" },
      },
      required: ["text"],
    },
    execute: (args: unknown) => {
      const text = String((args as { text?: unknown }).text ?? "");
      notes.push(text);
      return `recorded: ${text}`;
    },
  } as KernelTool;
  kernel.tools.register(note);
  const pump = new RunPump(kernel, runner);
  pump.start();

  const events: string[] = [];
  const pushEvent = (name: string): void => {
    if (!events.includes(name)) events.push(name);
  };
  let streamedChars = 0;
  const usage: { input: number; output: number; totalTokens: number }[] = [];
  let ended = false;
  const on = kernelOn(kernel.ctx);
  const offs = [
    on("message:update", (event) => {
      pushEvent("message:update");
      if (event.event.type === "text_delta")
        streamedChars += event.event.delta.length;
    }),
    on("tool:end", () => {
      pushEvent("tool:end");
    }),
    on("entry:added", () => {
      pushEvent("entry:added");
    }),
    on("usage:recorded", (event) => {
      pushEvent("usage:recorded");
      usage.push(event.row.usage);
    }),
    on("turn:run-end", (event) => {
      ended = true;
      pushEvent(`run-end:${event.status}`);
    }),
  ];

  kernel.inject({
    role: "user",
    content: [{ type: "text", text: PROMPT_REMEMBER }],
    timestamp: Date.now(),
  });
  await waitForIdle(runner, kernel, options.timeoutMs);
  // The pump stops the loop between runs; the events above already settled it.
  if (!ended) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!events.includes("tool:end")) {
    kernel.inject({
      role: "user",
      content: [{ type: "text", text: PROMPT_NUDGE }],
      timestamp: Date.now(),
    });
    await waitForIdle(runner, kernel, options.timeoutMs);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const firstAnswer = textsOf(runner.getTranscript() as never);

  // The transcript must survive a reload, and the model must answer from it —
  // through the same call, over the journal the first run just wrote.
  const resumed = await openSession({
    storage: options.storage,
    models: options.models,
    config: {
      model: { provider: options.provider, modelId: options.modelId },
      activeToolNames: ["note"],
    },
  });
  const resumedRunner: Runner = resumed.runner;
  resumed.kernel.tools.register(note);
  resumed.kernel.inject({
    role: "user",
    content: [{ type: "text", text: PROMPT_RECALL }],
    timestamp: Date.now(),
  });
  await resumedRunner.run();
  const recalled = textsOf(resumedRunner.getTranscript() as never);

  // The config and the ledger are on disk too, which is what a restart needs.
  const stats = await options.storage.getStats();
  const entries = await options.storage.scanEntries({});
  const report: SmokeReport = {
    notes,
    streamedChars,
    usage,
    firstAnswer,
    recalled,
    turns: kernel.turns,
    entries: entries.length,
    events,
    stats: {
      messageCount: stats.messageCount,
      input: stats.usage.input,
      output: stats.usage.output,
      totalTokens: stats.usage.totalTokens,
    },
    configRestored:
      resumed.configRestored && resumed.config.thinkingLevel === "low",
  };
  log(
    [
      `smoke: provider=${options.provider} model=${options.modelId}`,
      `smoke: turns=${report.turns} notes=${JSON.stringify(notes)} entries=${report.entries}`,
      `smoke: streamedChars=${streamedChars} usageRows=${usage.length}`,
      `smoke: stats=${JSON.stringify(report.stats)}`,
      `smoke: firstAnswer=${JSON.stringify(firstAnswer)}`,
      `smoke: recalled=${JSON.stringify(recalled)}`,
      `smoke: events=${events.join(",")}`,
      `smoke: configRestored=${resumed.configRestored} tasks=${JSON.stringify(resumed.tasks)}`,
    ].join("\n"),
  );

  for (const off of offs) off();
  pump.stop();
  opened.stop();
  resumed.stop();
  void kernel.dispose();
  void resumed.kernel.dispose();
  return report;
}
