import type { Host } from "../src/host";
/**
 * The product API's document (REFACTOR.md §9, P2.5).
 *
 * The claim is not "we wrote a document" but "the document is the surface": every `/api/v1` route
 * the host actually serves is described here, and nothing else is. That is checked against the
 * route registry rather than a list kept by hand, because the failure this guards against is a
 * route added to a handler and forgotten here — which is exactly how a generated client ends up
 * unable to call something that exists.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PRODUCT_ROUTES, productDocument } from "../src/compat/openapi";
import { assembleHost } from "../src/host";

const roots: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function start(): Promise<Host> {
  const root = await mkdtemp(join(tmpdir(), "eta-openapi-"));
  roots.push(root);
  await writeFile(
    join(root, "config.json"),
    JSON.stringify({ providers: [], defaultModel: "" }),
    "utf8",
  );
  const host = await assembleHost({
    dataDir: root,
    port: 0,
    warn: () => undefined,
  });
  hosts.push(host);
  return host;
}

/** The registry's `/a/:id/b` spelling, as OpenAPI writes it: `/a/{id}/b`. */
const asDocumentPath = (pattern: string): string =>
  pattern
    .split("/")
    .map((segment) =>
      segment.startsWith(":") ? `{${segment.slice(1)}}` : segment,
    )
    .join("/");

describe("the product document", () => {
  it("describes every /api/v1 route the host serves, and only those", async () => {
    const host = await start();
    const served = host.routes
      .routes()
      .map(
        (route) =>
          `${route.method.toLowerCase()} ${asDocumentPath(route.pattern)}`,
      );
    const documented = PRODUCT_ROUTES.map(
      (route) => `${route.method.toLowerCase()} ${route.path}`,
    );
    // Both directions, because both failures are real: an /api/v1 route nobody documented is one a
    // generated client cannot call, and a documented route nobody answers is one it calls in vain.
    // (The product's surface is not only `/api/v1` — an upload posts to `/artifacts/v1/upload` —
    // so the first check is the /api/v1 half and the second covers the whole document.)
    expect(served.filter((route) => route.includes(" /api/v1")).sort()).toEqual(
      documented.filter((route) => route.includes(" /api/v1")).sort(),
    );
    for (const route of documented) {
      expect(served, route).toContain(route);
    }
  });

  it("names its shapes, and every reference resolves", async () => {
    const document = productDocument() as {
      paths: Record<string, Record<string, unknown>>;
      components: { schemas: Record<string, unknown> };
    };
    const names = Object.keys(document.components.schemas);
    // The product's names, so a generated client can import them: the web reads Message, Group,
    // Snapshot, the event payloads and the rest by exactly these names.
    for (const expected of [
      "Agent",
      "AgentDeleted",
      "AgentUpdated",
      "Error",
      "Group",
      "GroupUpdated",
      "Interaction",
      "InteractionUpdated",
      "Message",
      "MessagePage",
      "MessageUpdated",
      "Send",
      "Sent",
      "Snapshot",
      "TextBlock",
    ]) {
      expect(names, expected).toContain(expected);
    }

    // Every `$ref` in the document points at something the document defines. A broken reference is
    // a client that cannot be generated at all, which is the failure this whole file is about.
    const references: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (typeof node !== "object" || node === null) return;
      for (const [key, value] of Object.entries(node)) {
        if (key === "$ref" && typeof value === "string") references.push(value);
        else walk(value);
      }
    };
    walk(document);
    expect(references.length).toBeGreaterThan(5);
    for (const reference of references) {
      expect(reference.startsWith("#/components/schemas/"), reference).toBe(
        true,
      );
      expect(names, reference).toContain(
        reference.replace("#/components/schemas/", ""),
      );
    }
  });

  it("is served, and says the things a client generator needs", async () => {
    const host = await start();
    const response = await fetch(
      `http://127.0.0.1:${host.port}/api/v1/openapi.json`,
    );
    expect(response.status).toBe(200);
    const document = (await response.json()) as {
      openapi: string;
      info: { title: string };
      paths: Record<
        string,
        Record<string, { responses?: Record<string, unknown> }>
      >;
    };
    expect(document.openapi).toBe("3.1.0");
    expect(document.info.title).toBe("eta product API");

    // Every route answers with something a generator can name, and can be refused.
    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        const answers = operation.responses ?? {};
        expect(
          Object.keys(answers).length,
          `${method} ${path}`,
        ).toBeGreaterThan(0);
        expect(
          Object.keys(answers).some((code) => code.startsWith("4")),
          `${method} ${path}`,
        ).toBe(true);
      }
    }

    // The stream is described as a stream, not as JSON.
    const stream = document.paths["/api/v1/chat/stream"]?.get as {
      responses: Record<string, { content?: Record<string, unknown> }>;
    };
    expect(Object.keys(stream.responses["200"]?.content ?? {})).toEqual([
      "text/event-stream",
    ]);

    // And the shapes are the product's: a snapshot carries a cursor and the cards still waiting.
    const named = productDocument() as {
      components: {
        schemas: Record<string, { properties?: Record<string, unknown> }>;
      };
    };
    expect(
      Object.keys(named.components.schemas.Snapshot?.properties ?? {}).sort(),
    ).toEqual([
      "active_replies",
      "agents",
      "event_cursor",
      "groups",
      "interactions",
    ]);
    expect(
      Object.keys(named.components.schemas.MessageUpdated?.properties ?? {}),
    ).toEqual(["message"]);
  });
});
