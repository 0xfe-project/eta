// The runtime's control API, for the control plane's controller only: it
// holds the token (Authorization: Bearer). Other agents' runtimes share the
// network and can reach this port, never the token.

import type { Context } from "hono";
import type { Agent, Answer, Kind } from "./agent.ts";
import type { Fetcher, Part } from "./attachments.ts";
import type { UserInput } from "./protocol/v2/UserInput";
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { userInput } from "./attachments.ts";

interface Input {
  boot_id?: unknown;
  command_id?: unknown;
  text?: unknown;
  parts?: unknown;
  kind?: unknown;
  approval_id?: unknown;
  decision?: unknown;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function controlAPI(
  agent: Agent,
  token: string,
  bootId: string,
  attachments: Fetcher,
): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (!same(c.req.header("authorization") ?? "", `Bearer ${token}`)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.get("/status", (c) => c.json({ boot_id: bootId, ...agent.status() }));

  // A prompt or steer names the boot it was meant for: one sent before this
  // boot reported itself started belongs to the previous one.
  // A message's parts (text and attachments) when it has them, else its text.
  const deliver =
    (
      run: (
        commandId: string,
        input: string | UserInput[],
        kind: Kind,
      ) => Promise<Answer>,
    ) =>
    async (c: Context) => {
      const body = (await c.req.json().catch(() => null)) as Input | null;
      if (
        typeof body?.command_id !== "string" ||
        typeof body.text !== "string"
      ) {
        return c.json({ error: "invalid" }, 400);
      }
      if (body.boot_id !== bootId) {
        return c.json({ accepted: false, code: "wrong_boot" }, 409);
      }
      const kind = body.kind === "compact" ? "compact" : "turn";
      let input: string | UserInput[] = body.text;
      if (Array.isArray(body.parts)) {
        try {
          input = await userInput(attachments, body.parts as Part[]);
        } catch (error) {
          return c.json(
            {
              accepted: false,
              code: "attachment_unavailable",
              reason: error instanceof Error ? error.message : String(error),
            },
            409,
          );
        }
      }
      const answer = await run(body.command_id, input, kind);
      return c.json(answer, answer.accepted ? 200 : 409);
    };
  app.post(
    "/prompt",
    deliver((id, text, kind) => agent.prompt(id, text, kind)),
  );
  app.post(
    "/steer",
    deliver((id, text) => agent.steer(id, text)),
  );

  // The user's answer to an approval; "not_pending" once it is gone.
  app.post("/decide", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Input | null;
    if (
      typeof body?.approval_id !== "string" ||
      typeof body.decision !== "string"
    ) {
      return c.json({ error: "invalid" }, 400);
    }
    return c.json({ result: agent.decide(body.approval_id, body.decision) });
  });

  app.post("/abort", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Input | null;
    if (typeof body?.command_id !== "string") {
      return c.json({ error: "invalid" }, 400);
    }
    await agent.abort(body.command_id);
    return c.json({});
  });
  return app;
}
