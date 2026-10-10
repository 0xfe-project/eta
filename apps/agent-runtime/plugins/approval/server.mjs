// The approval plugin's MCP server (stdio, one JSON-RPC message per line).
//
// An akhook `ask` rule (/etc/akhook/akhook.yml, or a workspace's own) blocks
// a command and leaves a request; `request_approval` shows it to the user
// through MCP elicitation and, once they accept, grants it, so the identical
// command passes once. It knows nothing about any particular rule.

import { execFile } from "node:child_process";
import process from "node:process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const run = promisify(execFile);
const AKHOOK = process.env.AKHOOK_BIN || "/usr/local/bin/akhook";
// What the product shows the user is capped at 500 characters.
const MESSAGE_CHARS = 500;
// A form without fields: the user only accepts or declines. Codex drops a
// schema with a title.
const CONFIRMATION = { type: "object", properties: {} };
const TOOL = {
  name: "request_approval",
  description:
    "Ask the user to approve a command that an AXP rule held back. Call this only with the request_id from such a rule's message. Once the user approves, run exactly the same command again; it then passes once.",
  inputSchema: {
    type: "object",
    properties: { request_id: { type: "string" } },
    required: ["request_id"],
  },
};

async function akhook(...args) {
  const { stdout } = await run(AKHOOK, ["approval", ...args], {
    timeout: 10_000,
  });
  return stdout;
}

function message(request) {
  const reasons = (request.rules ?? []).map((rule) => rule.message).join("\n");
  // akhook also lists every call as a plain tool_call; it is shown only when
  // nothing more specific describes it.
  const calls = [];
  const tools = [];
  for (const candidate of request.candidates ?? []) {
    if (candidate.type === "shell_exec") {
      calls.push(candidate.command);
    } else if (candidate.type === "file_change") {
      calls.push(`${candidate.action} ${candidate.path}`);
    } else if (candidate.type === "tool_call") {
      tools.push(`${candidate.name} ${JSON.stringify(candidate.args)}`);
    }
  }
  const text = `${reasons}\n\n${(calls.length ? calls : tools).join("\n")}`;
  return text.length > MESSAGE_CHARS
    ? `${text.slice(0, MESSAGE_CHARS - 1)}…`
    : text;
}

const send = (body) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...body })}\n`);
const asked = new Map();
let nextId = 1;

/** Ask the client (Codex) something; resolves with its answer. */
function ask(method, params) {
  const id = `approval-${nextId++}`;
  return new Promise((resolve, reject) => {
    asked.set(id, { resolve, reject });
    send({ id, method, params });
  });
}

async function requestApproval(requestId) {
  const request = JSON.parse(await akhook("show", requestId));
  const answer = await ask("elicitation/create", {
    message: message(request),
    requestedSchema: CONFIRMATION,
  });
  if (answer.action === "accept") {
    await akhook("grant", requestId);
    return "用户同意了。现在原样重新执行这条命令，只能执行一次。";
  }
  if (answer.action === "decline") {
    return "用户拒绝了。不要执行这条命令，也不要换个写法绕过。";
  }
  return "用户没有确认。不要执行这条命令。";
}

async function handle(method, params) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "approval", version: "1.0.0" },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: [TOOL] };
    case "tools/call": {
      if (params?.name !== TOOL.name) {
        throw Object.assign(new Error(`unknown tool ${params?.name}`), {
          code: -32602,
        });
      }
      try {
        const text = await requestApproval(
          String(params.arguments?.request_id ?? ""),
        );
        return { content: [{ type: "text", text }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: String(error?.message ?? error) }],
          isError: true,
        };
      }
    }
    default:
      throw Object.assign(new Error(`${method} is not supported`), {
        code: -32601,
      });
  }
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on(
  "line",
  (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method === undefined) {
      const waiting = asked.get(message.id);
      asked.delete(message.id);
      if (message.error) {
        waiting?.reject(new Error(message.error.message));
      } else {
        waiting?.resolve(message.result ?? {});
      }
      return;
    }
    if (message.id === undefined) {
      return; // notifications (initialized, cancelled): nothing to do
    }
    handle(message.method, message.params).then(
      (result) => send({ id: message.id, result }),
      (error) =>
        send({
          id: message.id,
          error: {
            code: error.code ?? -32603,
            message: String(error.message ?? error),
          },
        }),
    );
  },
);
