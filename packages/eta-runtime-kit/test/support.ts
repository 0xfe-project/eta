/**
 * A served MCP server as a runtime sees it, for tests: what it lists, and what it says on its
 * event stream.
 */

export interface Served {
  url: string;
  headers?: Readonly<Record<string, string>> | undefined;
}

export interface ListedTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

/** The tools a served MCP server lists now. */
export async function listServed(server: Served): Promise<ListedTool[]> {
  const response = await fetch(server.url, {
    method: "POST",
    headers: {
      ...server.headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const reply = (await response.json()) as { result: { tools: ListedTool[] } };
  return reply.result.tools;
}

/** Listen on the server's event stream, as a runtime does for notifications; what it hears. */
export async function listenServed(
  server: Served,
): Promise<{ heard: string[]; close: () => void }> {
  const controller = new AbortController();
  const response = await fetch(server.url, {
    headers: { ...server.headers, accept: "text/event-stream" },
    signal: controller.signal,
  });
  const heard: string[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({
        value: undefined,
        done: true,
      }));
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (
        let end = buffer.indexOf("\n\n");
        end >= 0;
        end = buffer.indexOf("\n\n")
      ) {
        const data = /^data: (.*)$/m.exec(buffer.slice(0, end))?.[1];
        buffer = buffer.slice(end + 2);
        if (data !== undefined)
          heard.push((JSON.parse(data) as { method: string }).method);
      }
    }
  })();
  return { heard, close: () => controller.abort() };
}
