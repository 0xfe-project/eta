import { getLogger } from "@logtape/logtape";
import { z } from "zod";
import { setupTelemetry } from "./telemetry.ts";

const log = getLogger(["web", "browser"]);
const MAX_BYTES = 64 * 1024;

const recordsSchema = z
  .array(
    z.object({
      level: z.enum(["debug", "info", "warn", "error"]),
      message: z.string().max(4000),
      attributes: z
        .record(
          z.string().max(100),
          z.union([z.string().max(2000), z.number(), z.boolean()]),
        )
        .refine((value) => Object.keys(value).length <= 20)
        .optional(),
    }),
  )
  .max(50);

const methods = {
  debug: "debug",
  info: "info",
  warn: "warn",
  error: "error",
} as const;

/** Accepts browser log records and logs them on the server as web.browser. */
export async function receiveBrowserLogs(request: Request): Promise<Response> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BYTES)
    return new Response(null, { status: 413 });
  const text = await request.text();
  if (text.length > MAX_BYTES) return new Response(null, { status: 413 });
  let parsed;
  try {
    parsed = recordsSchema.safeParse(JSON.parse(text));
  } catch {
    return new Response(null, { status: 400 });
  }
  if (!parsed.success) return new Response(null, { status: 400 });

  // The dev server renders without server.js, so set up here as well.
  await setupTelemetry("web");
  const userAgent = request.headers.get("user-agent") ?? undefined;
  for (const record of parsed.data) {
    log[methods[record.level]](record.message, {
      ...record.attributes,
      "user_agent.original": userAgent,
    });
  }
  return new Response(null, { status: 204 });
}
