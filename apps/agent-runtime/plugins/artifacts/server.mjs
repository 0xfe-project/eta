// The artifacts plugin's MCP server (stdio, one JSON-RPC message per line).
//
// publish_artifact uploads a static site, a ZIP or a directory zipped here,
// to AXP through the runtime gateway (/artifacts/v1/upload, the same upload
// remote computers' `axp artifact upload` uses). Its result names the
// version for the transcript's card (_meta "axp/ref").

import { Buffer } from "node:buffer";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { crc32, deflateRawSync } from "node:zlib";

const GATEWAY = process.env.AXP_GATEWAY_URL;
const KEY = process.env.AXP_AGENT_KEY;
const WORKSPACE = process.env.AXP_WORKSPACE_DIR || process.cwd();
// The server's limit for the ZIP (artifacts.DefaultLimits).
const MAX_ZIP = 90 * 1024 * 1024;

const TOOL = {
  name: "publish_artifact",
  description:
    "Publish a static site (an index.html at its root, with its CSS, JS and images) as an AXP artifact the user can open " +
    "in the chat or task and share. path is a .zip or a directory (zipped for you). Every publish is a new version; pass " +
    "artifact (its id) to publish the next version of one you published, else a new artifact is made.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "the site's directory, or a .zip of it; relative to the workspace",
      },
      title: {
        type: "string",
        description:
          "a short title; required for a new artifact, a new version keeps the current one without it",
      },
      task: {
        type: "string",
        description:
          "the task (number or id) to show it on as well, when it is for one",
      },
      artifact: {
        type: "string",
        description: "the artifact's id, to publish its next version",
      },
    },
    required: ["path"],
  },
};

// --- zip ---------------------------------------------------------------------

/** A directory's files as [name, path] relative to it; no links. */
async function walk(root, dir = root, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const name = relative(root, path).split(sep).join("/");
    if (entry.isSymbolicLink()) {
      throw new Error(`不能打包符号链接：${name}`);
    }
    if (entry.isDirectory()) {
      if (entry.name !== ".git" && entry.name !== "node_modules") {
        await walk(root, path, out);
      }
    } else if (entry.isFile()) {
      out.push([name, path]);
    }
  }
  return out;
}

/** A ZIP (deflate, UTF-8 names) of a directory's files. */
async function zipDirectory(dir) {
  const files = await walk(dir);
  if (!files.some(([name]) => name === "index.html")) {
    throw new Error(`${dir} 的根目录没有 index.html`);
  }
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, path] of files) {
    const data = await readFile(path);
    const packed = deflateRawSync(data);
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.write("PK\x03\x04", 0, "latin1"); // local file header
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0x21, 12); // 1980-01-01
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    const entry = Buffer.alloc(46);
    entry.write("PK\x01\x02", 0, "latin1"); // central directory entry
    entry.writeUInt16LE(0x0314, 4); // made on Unix
    entry.writeUInt16LE(20, 6);
    header.copy(entry, 8, 6, 30); // flags through name length
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38); // a regular file
    entry.writeUInt32LE(offset, 42);
    parts.push(header, nameBytes, packed);
    central.push(entry, nameBytes);
    offset += header.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.write("PK\x05\x06", 0, "latin1"); // end of central directory
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

// --- tool --------------------------------------------------------------------

async function publish(args) {
  const path = resolve(WORKSPACE, String(args.path ?? ""));
  const info = await lstat(path).catch(() => null);
  if (!info) {
    throw new Error(`找不到 ${path}`);
  }
  const body = info.isDirectory()
    ? await zipDirectory(path)
    : await readFile(path);
  if (body.length > MAX_ZIP) {
    throw new Error(
      `ZIP 有 ${(body.length / 1048576).toFixed(1)} MiB，超过 90 MiB`,
    );
  }
  const query = new URLSearchParams();
  for (const name of ["title", "task", "artifact"]) {
    if (args[name]) query.set(name, String(args[name]));
  }
  const response = await fetch(`${GATEWAY}/artifacts/v1/upload?${query}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/zip",
    },
    body,
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      result?.error?.message ?? `上传失败（HTTP ${response.status}）`,
    );
  }
  return result;
}

async function call(args) {
  try {
    const out = await publish(args ?? {});
    return {
      content: [
        {
          type: "text",
          text: `已发布「${out.title}」第 ${out.version} 版（artifact ${out.artifact_id}，${out.files} 个文件）。用户在聊天${out.task_id ? "和任务" : ""}里点卡片即可预览；需要时由用户自己公开分享。`,
        },
      ],
      structuredContent: out,
      _meta: {
        "axp/ref": {
          kind: "artifact",
          id: out.artifact_id,
          title: out.title,
          number: out.version,
        },
      },
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: String(error?.message ?? error) }],
      isError: true,
    };
  }
}

async function handle(method, params) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "artifacts", version: "1.0.0" },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: [TOOL] };
    case "tools/call":
      if (params?.name !== TOOL.name) {
        throw Object.assign(new Error(`unknown tool ${params?.name}`), {
          code: -32602,
        });
      }
      return call(params.arguments);
    default:
      throw Object.assign(new Error(`${method} is not supported`), {
        code: -32601,
      });
  }
}

const send = (body) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...body })}\n`);

createInterface({ input: process.stdin, crlfDelay: Infinity }).on(
  "line",
  (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id === undefined || message.method === undefined) {
      return; // notifications and answers: nothing to do
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
