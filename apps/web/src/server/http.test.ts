import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { expect, it } from "@rstest/core";
import { webApiMiddleware } from "./http.ts";

/** One request through the dev server's middleware: what it wrote, or that it passed it on. */
async function ask(url: string, method = "GET") {
  const req = Object.assign(Readable.from([]), {
    url,
    method,
    headers: { host: "web" },
  }) as unknown as IncomingMessage;
  const headers: Record<string, string> = {};
  let passed = false;
  const answered = await new Promise<{ status: number; body: string } | null>(
    (resolve) => {
      const res = {
        statusCode: 0,
        setHeader: (key: string, value: string) => {
          headers[key.toLowerCase()] = value;
        },
        end(this: { statusCode: number }, body: Uint8Array) {
          resolve({
            status: this.statusCode,
            body: new TextDecoder().decode(body),
          });
        },
      } as unknown as ServerResponse;
      webApiMiddleware(() => "build-1")(req, res, () => {
        passed = true;
        resolve(null);
      });
    },
  );
  return { answered, headers, passed, consumed: req.readableEnded };
}

it("answers health and the current build id", async () => {
  const up = await ask("/up");
  expect(up.answered).toEqual({ status: 200, body: "ok" });

  const version = await ask("/version");
  expect(version.answered).toEqual({ status: 200, body: "build-1" });
  expect(version.headers["cache-control"]).toBe("no-store");
});

it("leaves page and asset requests to the static / SPA server, body unread", async () => {
  for (const path of ["/tasks", "/assets/app.js"]) {
    const { passed, answered, consumed } = await ask(path, "POST");
    expect(passed).toBe(true);
    expect(answered).toBeNull();
    expect(consumed).toBe(false);
  }
});
