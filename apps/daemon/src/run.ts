/**
 * One run of a session, from the words that start it to the quiet after it.
 *
 * The same few lines serve a session on the primary (the conversation engine runs it in process)
 * and one on a daemon (the primary asks for it over the link), so a reply means the same thing
 * wherever it ran: the words go in as the session's next run, the runner goes until nothing is
 * left in the inbox, and what the session said is the text of its last assistant message that
 * had any, with what it thought in the same message (or, failing that, the last thought it had).
 */
import type {
  PromptImage,
  RunOutcome,
  ToolActivity,
} from "@eta/client-contracts";
import type { AgentMessage } from "@eta/core";
import type { ManagedSession } from "@eta/server";
import { kernelOn } from "@eta/core";
import { ActivityRecorder } from "./activity";

/** What a session says during a run; `stop` lets go of the listener. */
export function listen(managed: ManagedSession): {
  said: () => {
    text: string;
    thinking: string;
    activity: ToolActivity[];
    failure: RunOutcome["failure"];
  };
  stop: () => void;
} {
  let text = "";
  let thinking = "";
  let failure: RunOutcome["failure"];
  const activity = new ActivityRecorder();
  const off = kernelOn(managed.session.kernel.ctx)(
    "message:end",
    ({ message }: { message: AgentMessage }) => {
      activity.see(message);
      if (message.role !== "assistant") return;
      const blocks = Array.isArray(message.content) ? message.content : [];
      const spoken = blocks
        .filter((block) => block.type === "text")
        .map((block) => (block as { text: string }).text)
        .join("");
      const thought = blocks
        .filter((block) => block.type === "thinking")
        .map((block) => (block as { thinking: string }).thinking)
        .join("\n\n")
        .trim();
      if (thought !== "") thinking = thought;
      if (spoken.trim() !== "") text = spoken;
    },
  );
  const offFailure = kernelOn(managed.session.kernel.ctx)(
    "turn:run-failed",
    ({ failure: classified }: { failure?: RunOutcome["failure"] }) => {
      if (classified !== undefined) failure = classified;
    },
  );
  return {
    said: () => ({ text, thinking, activity: activity.list(), failure }),
    stop: () => {
      off();
      offFailure();
    },
  };
}

/**
 * Where the session's journal stands. Whatever is written from here on has a higher `seq`, so this
 * is the line between what the session said before and what the next run will say.
 */
export function lastSeq(managed: ManagedSession): number {
  return managed.session.journaling.entries().at(-1)?.seq ?? 0;
}

/**
 * Run the session on `prompt` until it is quiet. Words that reached the inbox after the run's
 * last look (a steer that lost the race) belong to this run too; a run that failed leaves the
 * inbox as it found it, and asking again would only fail again. `keepGoing` lets a caller that
 * is shutting down end the loop. `images` go in the same first message as the words.
 */
export async function runAndWait(
  managed: ManagedSession,
  prompt: string,
  keepGoing: () => boolean = () => true,
  images: readonly PromptImage[] = [],
): Promise<RunOutcome> {
  const heard = listen(managed);
  try {
    const { kernel, runner } = managed.session;
    kernel.nextRun({
      role: "user",
      timestamp: Date.now(),
      content: [
        { type: "text", text: prompt },
        ...images.map((image) => ({
          type: "image" as const,
          data: image.dataBase64,
          mimeType: image.mime,
        })),
      ],
    });
    let result = await runner.run();
    while (
      result.status === "completed" &&
      kernel.inboxDepth > 0 &&
      keepGoing()
    )
      result = await runner.run();
    const said = heard.said();
    return {
      status: result.status,
      ...(result.status === "failed"
        ? {
            error: result.error ?? "The run failed.",
            ...(said.failure === undefined ? {} : { failure: said.failure }),
          }
        : {}),
      text: said.text,
      thinking: said.thinking,
      ...(said.activity.length === 0 ? {} : { activity: said.activity }),
    };
  } finally {
    heard.stop();
  }
}
