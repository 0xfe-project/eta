/**
 * A model on the OpenAI API that does what the last message says, so a host can be given work with
 * no real provider. Marks in the text ask for a tool; in a task's session it finishes the task.
 *
 *   bun scripts/upgrade-e2e/fake-model.ts [port]
 */
import process from "node:process";

interface Message {
  role: string;
  content?: string | { type: string; text?: string }[] | null;
}

interface Request {
  messages: Message[];
  tools?: { function: { name: string } }[];
}

export const MARK = {
  artifact: "[seed:artifact]",
  version: "[seed:version ",
  task: "[seed:task]",
} as const;

const textOf = ({ content }: Message): string =>
  typeof content === "string"
    ? content
    : (content ?? []).map((part) => part.text ?? "").join("");

type Answer =
  | { text: string }
  | { tool: string; args: Record<string, unknown> };

function answer({ messages, tools = [] }: Request): Answer {
  const last = messages.at(-1);
  if (last === undefined || last.role === "tool") return { text: "Done." };
  const said = textOf(last);
  if (tools.some((tool) => tool.function.name === "finish_task"))
    return { tool: "finish_task", args: { summary: "Seed run finished." } };
  if (said.includes(MARK.artifact))
    return { tool: "publish_artifact", args: { path: "site", title: "Seed" } };
  const version = said.indexOf(MARK.version);
  if (version !== -1) {
    const artifactId = said.slice(version + MARK.version.length).split("]")[0];
    return {
      tool: "publish_artifact",
      args: { path: "site", title: "Seed", artifactId },
    };
  }
  if (said.includes(MARK.task))
    return {
      tool: "create_task",
      args: {
        title: "Seed task",
        description: "A task for the seed.",
        workspace: "local",
      },
    };
  return { text: `Heard: ${said.slice(-80)}` };
}

const chunk = (delta: Record<string, unknown>, finish?: string): string =>
  `data: ${JSON.stringify({
    id: "fake",
    object: "chat.completion.chunk",
    model: "m1",
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  })}\n\n`;

function stream(said: Answer): string {
  const body =
    "text" in said
      ? [chunk({ role: "assistant", content: said.text }), chunk({}, "stop")]
      : [
          chunk({
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call-${crypto.randomUUID()}`,
                type: "function",
                function: {
                  name: said.tool,
                  arguments: JSON.stringify(said.args),
                },
              },
            ],
          }),
          chunk({}, "tool_calls"),
        ];
  const usage = {
    id: "fake",
    object: "chat.completion.chunk",
    model: "m1",
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
  return [
    ...body,
    `data: ${JSON.stringify(usage)}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

export const serveModel = (port: number): ReturnType<typeof Bun.serve> =>
  Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname.endsWith("/models"))
        return Response.json({ data: [{ id: "m1" }] });
      if (!pathname.endsWith("/chat/completions"))
        return new Response("Not Found", { status: 404 });
      return new Response(stream(answer((await request.json()) as Request)), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

if (import.meta.main) serveModel(Number(process.argv[2] ?? 19_901));
