// The oo CLI as one MCP tool, so that the user's OOMOL key (OO_API_KEY, OO_TEAM_NAME) lives in
// this process and in the `oo` it starts, and not in the agent's shell. No dependencies: the
// stdio transport is one JSON-RPC message per line.
import { spawn } from "node:child_process";
import process from "node:process";
import { createInterface } from "node:readline";

const TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 256 * 1024;

const tool = {
  name: "oo",
  description:
    'Run the oo CLI of OOMOL with these arguments (no shell). `args: ["--help"]` lists what it can do; its apps and hosted capabilities are used as `oo <command> ...`.',
  inputSchema: {
    type: "object",
    properties: {
      args: { type: "array", items: { type: "string" } },
    },
    required: ["args"],
  },
};

function run(args) {
  return new Promise((resolve) => {
    const child = spawn("oo", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let out = "";
    const take = (chunk) => {
      if (out.length < MAX_OUTPUT) out += chunk.toString("utf8");
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ text: `could not run oo: ${error.message}`, isError: true });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        text: out.slice(0, MAX_OUTPUT) || `(no output, exit ${code})`,
        isError: code !== 0,
      });
    });
  });
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin }).on("line", async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (id === undefined) return; // a notification
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "oomol", version: "1.0.0" },
      },
    });
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: [tool] } });
  } else if (method === "tools/call") {
    const args = params?.arguments?.args;
    if (
      params?.name !== "oo" ||
      !Array.isArray(args) ||
      args.some((item) => typeof item !== "string")
    ) {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: "oo takes args: a list of strings" }],
          isError: true,
        },
      });
      return;
    }
    const { text, isError } = await run(args);
    send({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text }], isError },
    });
  } else {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `no method ${method}` },
    });
  }
});
