import type { ObservedOutputs } from "../src/output-shape";
/**
 * The smaller parts on their own: output shapes, the metadata cache, schema
 * validation and the failure tracker.
 */
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FAILURE_BACKOFF_MS, FailureTracker } from "../src/failure-backoff";
import { schemaViolation } from "../src/json-schema";
import { MetadataCache } from "../src/metadata-cache";
import {
  getObservedOutput,
  outputShapeKey,
  recordObservedOutput,
  renderOutputShape,
  seedObservedOutputs,
} from "../src/output-shape";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "eta-mcp-units-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("observed output shapes", () => {
  const tool = { name: "t", description: "d", inputSchema: { type: "object" } };
  const key = outputShapeKey(tool);
  const jsonText = (value: unknown) => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
  });

  it("records field names and types from JSON text, never values", () => {
    const observed: ObservedOutputs = new Map();
    recordObservedOutput(
      observed,
      "t",
      key,
      jsonText({
        id: 7,
        name: "secret-name",
        tags: ["a", "b"],
        owner: { login: "x" },
      }),
    );
    const seen = getObservedOutput(observed, tool)!;
    expect(seen.source).toBe("jsonText");
    const rendered = renderOutputShape(seen.shape);
    expect(rendered).toBe(
      "{ id: number; name: string; tags: string[]; owner: { login: string; }; }",
    );
    expect(JSON.stringify(seen)).not.toContain("secret-name");
  });

  it("prefers structuredContent and ignores text that is not JSON", () => {
    const observed: ObservedOutputs = new Map();
    recordObservedOutput(observed, "t", key, {
      content: [{ type: "text", text: "plain words" }],
    });
    expect(observed.size).toBe(0);
    recordObservedOutput(observed, "t", key, {
      content: [],
      structuredContent: { ok: true },
    });
    expect(observed.get("t")?.source).toBe("structuredContent");
  });

  it("merges later results: fields that are missing become optional, types become unions", () => {
    const observed: ObservedOutputs = new Map();
    recordObservedOutput(observed, "t", key, jsonText({ a: 1, b: "x" }));
    recordObservedOutput(
      observed,
      "t",
      key,
      jsonText({ a: "now text", c: true }),
    );
    expect(renderOutputShape(observed.get("t")!.shape)).toBe(
      "{ a: number | string; b?: string; c?: boolean; }",
    );
  });

  it("treats objects keyed by data as maps, so ids and dates are not kept", () => {
    const observed: ObservedOutputs = new Map();
    recordObservedOutput(
      observed,
      "t",
      key,
      jsonText({ "2024-01-01": { n: 1 }, "2024-01-02": { n: 2 } }),
    );
    expect(renderOutputShape(observed.get("t")!.shape)).toBe(
      "Record<string, { n: number; }>",
    );
  });

  it("names a wide object that repeats", () => {
    const observed: ObservedOutputs = new Map();
    const user = {
      login: "a",
      id: 1,
      avatar_url: "u",
      html_url: "h",
      site_admin: false,
    };
    recordObservedOutput(
      observed,
      "t",
      key,
      jsonText({ user, assignee: user }),
    );
    const rendered = renderOutputShape(observed.get("t")!.shape);
    expect(rendered).toContain("type ");
    expect(rendered.match(/login: string/g)).toHaveLength(1);
  });

  it("is only used for the tool definition it was learned against", () => {
    const observed: ObservedOutputs = new Map();
    recordObservedOutput(observed, "t", key, jsonText({ a: 1 }));
    expect(getObservedOutput(observed, tool)).toBeDefined();
    expect(
      getObservedOutput(observed, { ...tool, description: "changed" }),
    ).toBeUndefined();
    expect(
      getObservedOutput(observed, {
        ...tool,
        outputSchema: { type: "object" },
      }),
    ).toBeUndefined();
  });

  it("is seeded from the cache only for unchanged tools, and rejects shapes it did not write", () => {
    const source: ObservedOutputs = new Map();
    recordObservedOutput(source, "t", key, jsonText({ a: 1 }));
    const saved = Object.fromEntries(source);

    const same: ObservedOutputs = new Map();
    seedObservedOutputs(same, saved, [tool]);
    expect(getObservedOutput(same, tool)).toBeDefined();

    const changed: ObservedOutputs = new Map();
    seedObservedOutputs(changed, saved, [{ ...tool, description: "other" }]);
    expect(changed.size).toBe(0);

    const hostile: ObservedOutputs = new Map();
    seedObservedOutputs(
      hostile,
      {
        t: {
          source: "jsonText",
          toolKey: key,
          shape: {
            type: "object",
            properties: { "bad key!": { type: "string" } },
          },
        },
      },
      [tool],
    );
    expect(hostile.size).toBe(0);
    seedObservedOutputs(
      hostile,
      {
        t: {
          source: "other" as never,
          toolKey: key,
          shape: { type: "string" },
        },
      },
      [tool],
    );
    expect(hostile.size).toBe(0);
  });

  it("keeps the rendered shape small", () => {
    const observed: ObservedOutputs = new Map();
    const wide = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [
        `field_${index}`,
        { nested: { deeper: { deepest: { x: 1, y: [1, 2] } } } },
      ]),
    );
    recordObservedOutput(observed, "t", key, jsonText(wide));
    expect(
      renderOutputShape(observed.get("t")!.shape).length,
    ).toBeLessThanOrEqual(4096);
  });
});

describe("metadata cache", () => {
  const entry = (hash: string, names: string[]) => ({
    configHash: hash,
    tools: names.map((name) => ({ name, description: name })),
  });

  it("serves an entry for its config hash only", () => {
    const cache = new MetadataCache(join(dir, "c.json"));
    cache.save({ s: entry("h1", ["a"]) });
    expect(cache.get("s", "h1")?.tools.map((tool) => tool.name)).toEqual(["a"]);
    expect(cache.get("s", "h2")).toBeUndefined();
    expect(cache.get("other", "h1")).toBeUndefined();
  });

  it("persists across instances and merges writes from several", () => {
    const path = join(dir, "c.json");
    const one = new MetadataCache(path);
    const two = new MetadataCache(path);
    one.save({ a: entry("h", ["x"]) });
    two.save({ b: entry("h", ["y"]) });
    one.save({ c: entry("h", ["z"]) });
    const fresh = new MetadataCache(path);
    expect(
      ["a", "b", "c"].map((name) => fresh.get(name, "h")?.tools[0]?.name),
    ).toEqual(["x", "y", "z"]);
  });

  it("remembers a failed discovery apart from a usable entry", () => {
    const cache = new MetadataCache(join(dir, "c.json"));
    cache.save({ s: { configHash: "h", tools: [], discoveryFailed: true } });
    expect(cache.get("s", "h")).toBeUndefined();
    expect(cache.discoveryFailed("s", "h")).toBe(true);
    expect(cache.discoveryFailed("s", "changed")).toBe(false);
  });

  it("keeps observed shapes through a refresh under the same hash, not a new one", () => {
    const cache = new MetadataCache(join(dir, "c.json"));
    const shapes = {
      a: {
        source: "jsonText" as const,
        shape: { type: "string" },
        toolKey: "k",
      },
    };
    cache.save({ s: { ...entry("h", ["a"]), outputShapes: shapes } });
    cache.save({ s: entry("h", ["a", "b"]) });
    expect(cache.get("s", "h")?.outputShapes).toEqual(shapes);
    cache.save({ s: entry("h2", ["a"]) });
    expect(cache.get("s", "h2")?.outputShapes).toBeUndefined();
  });

  it("starts empty from a corrupt file or another version, and replaces it on save", () => {
    const path = join(dir, "c.json");
    writeFileSync(path, "{ nope");
    const cache = new MetadataCache(path);
    expect(cache.get("s", "h")).toBeUndefined();
    cache.save({ s: entry("h", ["a"]) });
    expect(new MetadataCache(path).get("s", "h")).toBeDefined();
    writeFileSync(
      path,
      JSON.stringify({ version: 99, servers: { s: entry("h", ["a"]) } }),
    );
    expect(new MetadataCache(path).get("s", "h")).toBeUndefined();
  });

  it("creates its directory and drops entries on request", () => {
    const path = join(dir, "deep", "er", "c.json");
    const cache = new MetadataCache(path);
    cache.save({ s: entry("h", ["a"]) });
    // The save landed on disk, under directories it had to create.
    expect(new MetadataCache(path).get("s", "h")).toBeDefined();
    cache.remove("s");
    expect(new MetadataCache(path).get("s", "h")).toBeUndefined();
  });

  it("stamps when an entry was written", () => {
    const cache = new MetadataCache(join(dir, "c.json"), () => 4242);
    cache.save({ s: entry("h", ["a"]) });
    expect(cache.get("s", "h")?.cachedAt).toBe(4242);
  });
});

describe("schemaViolation", () => {
  it("validates draft 2020-12, draft-07 and unstamped schemas", () => {
    const schema = {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
    };
    expect(schemaViolation(schema, { n: 1 })).toBeUndefined();
    expect(schemaViolation(schema, { n: "1" })).toBeDefined();
    expect(schemaViolation(schema, {})).toBeDefined();
    const draft07 = {
      $schema: "http://json-schema.org/draft-07/schema#",
      ...schema,
    };
    expect(schemaViolation(draft07, { n: 1 })).toBeUndefined();
    expect(schemaViolation(draft07, {})).toBeDefined();
    const draft2020 = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      ...schema,
    };
    expect(schemaViolation(draft2020, { n: 1 })).toBeUndefined();
  });

  it("lets the server judge what it cannot evaluate", () => {
    expect(
      schemaViolation(
        { $schema: "http://example.com/custom", type: "string" },
        5,
      ),
    ).toBeUndefined();
    expect(schemaViolation({ $ref: "#/missing" }, 5)).toBeUndefined();
    expect(schemaViolation(undefined, 5)).toBeUndefined();
    expect(schemaViolation("string", 5)).toBeUndefined();
  });

  it("accepts the numeric formats Rust servers write", () => {
    expect(
      schemaViolation({ type: "integer", format: "uint32", minimum: 0 }, 5),
    ).toBeUndefined();
    expect(
      schemaViolation({ type: "integer", format: "uint32", minimum: 0 }, -5),
    ).toBeDefined();
  });
});

describe("failure tracker", () => {
  it("reports a failure for a minute, with the reason cut short", () => {
    let now = 0;
    const tracker = new FailureTracker(() => now);
    expect(tracker.describe("k")).toBeUndefined();
    tracker.record("k", `first line\n\tsecond ${"word ".repeat(200)}`);
    now = 12_000;
    const described = tracker.describe("k")!;
    expect(described.startsWith("failed 12s ago: first line second")).toBe(
      true,
    );
    expect(described.length).toBeLessThan(340);
    expect(described).not.toContain("\n");
    now = FAILURE_BACKOFF_MS + 1;
    expect(tracker.describe("k")).toBeUndefined();
    expect(tracker.message("k")).toBeUndefined();
  });

  it("clears on success", () => {
    const tracker = new FailureTracker(() => 0);
    tracker.record("k", "x");
    tracker.clear("k");
    expect(tracker.ageSeconds("k")).toBeUndefined();
  });
});
