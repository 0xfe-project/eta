import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { userInput } from "./attachments.ts";

const files: Record<string, string> = { a1: "PNGDATA", a2: "a,b\n1,2\n" };
const asked: string[] = [];
const server = Bun.serve({
  port: 0,
  fetch(request) {
    asked.push(
      `${request.headers.get("authorization")} ${new URL(request.url).pathname}`,
    );
    const id = new URL(request.url).pathname.split("/").pop()!;
    return id in files
      ? new Response(files[id])
      : new Response("", { status: 404 });
  },
});
afterAll(() => server.stop());

describe("userInput", () => {
  const dir = mkdtempSync(join(tmpdir(), "axp-attachments-"));
  const f = {
    gatewayUrl: `http://127.0.0.1:${server.port}`,
    agentKey: "key",
    dir,
  };

  test("keeps the parts' order: images as images, files as paths", async () => {
    const input = await userInput(f, [
      { type: "text", text: "看图：" },
      {
        type: "attachment",
        id: "a1",
        name: "shot.png",
        content_type: "image/png",
        size: 7,
      },
      { type: "text", text: "\n和表格" },
      {
        type: "attachment",
        id: "a2",
        name: "data.csv",
        content_type: "text/csv",
        size: 8,
      },
    ]);
    const png = join(dir, "a1", "shot.png");
    const csv = join(dir, "a2", "data.csv");
    expect(input).toEqual([
      { type: "text", text: "看图：", text_elements: [] },
      {
        type: "text",
        text: `[图片：shot.png（image/png，7 B），已保存到 ${png}]`,
        text_elements: [],
      },
      { type: "localImage", path: png },
      { type: "text", text: "\n和表格", text_elements: [] },
      {
        type: "text",
        text: `[附件：data.csv（text/csv，8 B），已保存到 ${csv}，需要时用工具读取]`,
        text_elements: [],
      },
    ]);
    expect(readFileSync(csv, "utf8")).toBe(files.a2);
    expect(asked).toEqual([
      "Bearer key /attachments/v1/a1",
      "Bearer key /attachments/v1/a2",
    ]);
  });

  test("fetches a file once", async () => {
    asked.length = 0;
    await userInput(f, [
      {
        type: "attachment",
        id: "a2",
        name: "data.csv",
        content_type: "text/csv",
        size: 8,
      },
    ]);
    expect(asked).toEqual([]);
  });

  test("fails when a file cannot be fetched", async () => {
    await expect(
      userInput(f, [
        {
          type: "attachment",
          id: "gone",
          name: "x.bin",
          content_type: "application/octet-stream",
          size: 1,
        },
      ]),
    ).rejects.toThrow("404");
  });
});
