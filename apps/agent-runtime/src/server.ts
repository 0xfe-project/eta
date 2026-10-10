// The runtime's control API, for the control plane's controller only: it
// holds the token (Authorization: Bearer). Other agents' runtimes share the
// network and can reach this port, never the token.

import type { Context } from "hono";
import type { Agent, Answer, Kind } from "./agent.ts";
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";

interface Input {
  boot_id?: unknown;
  command_id?: unknown;
  text?: unknown;
  kind?: unknown;
  approval_id?: unknown;
  decision?: unknown;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function controlAPI(agent: Agent, token: string, bootId: string): Hono {
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
  const deliver =
    (run: (commandId: string, text: string, kind: Kind) => Promise<Answer>) =>
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
      const answer = await run(body.command_id, body.text, kind);
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
