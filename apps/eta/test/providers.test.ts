import type { EtaProviderConfig } from "../src/providers/config-types";
/**
 * The model layer (REFACTOR.md §9, P0.6): a config file in, a model layer the kernel can use out.
 *
 * No network here on purpose — building a provider is configuration work (which kind, which
 * headers, which models the user selected), and the transport only loads when a request is
 * actually made. A real request is `models.e2e.test.ts`, which needs the machine's own config.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configuredProviders, readConfig } from "../src/config";
import { configDefaultModel } from "../src/providers/config-types";
import { buildModels } from "../src/providers/runtime";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function scratchConfig(config: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eta-providers-"));
  roots.push(root);
  const path = join(root, "config.json");
  await writeFile(path, JSON.stringify(config), "utf8");
  return path;
}

const localProvider = (
  over: Partial<EtaProviderConfig> = {},
): EtaProviderConfig => ({
  id: "local",
  name: "Local",
  kind: "openai-compatible",
  baseUrl: "http://127.0.0.1:1/v1",
  models: [{ id: "m1" }, { id: "m2" }],
  ...over,
});

describe("building the model layer", () => {
  it("turns the configured providers into one layer, and resolves a model by name", async () => {
    const { models, failed } = await buildModels([localProvider()]);
    expect(failed).toEqual([]);
    expect(models).toBeDefined();

    const model = models?.getModel("local", "m1");
    expect(model?.id).toBe("m1");
    // The base URL the config gave is the one requests go to.
    expect(model?.baseUrl).toBe("http://127.0.0.1:1/v1");
  });

  it("reports the provider it cannot build, and keeps the others", async () => {
    const { models, failed } = await buildModels([
      localProvider({ id: "odd", kind: "no-such-kind" as never }),
      localProvider(),
    ]);
    expect(failed.map((failure) => failure.id)).toEqual(["odd"]);
    expect(failed[0]?.error).toContain("unsupported provider kind");
    expect(models?.getModel("local", "m1")).toBeDefined();
    // The one that failed is not silently usable.
    expect(models?.getModel("odd", "m1")).toBeUndefined();
  });

  it("is undefined — not an error — when no provider is configured", async () => {
    const { models, failed } = await buildModels([]);
    expect(models).toBeUndefined();
    expect(failed).toEqual([]);
  });

  it("only serves the models the config lists", async () => {
    const { models } = await buildModels([
      localProvider({ models: [{ id: "m1" }] }),
    ]);
    expect(models?.getModel("local", "m1")).toBeDefined();
    expect(models?.getModel("local", "m2")).toBeUndefined();
  });
});

describe("reading the config file", () => {
  it("warns and starts empty when there is no file", async () => {
    const root = await mkdtemp(join(tmpdir(), "eta-providers-"));
    roots.push(root);
    const warnings: string[] = [];
    const config = await readConfig(join(root, "config.json"), (message) =>
      warnings.push(message),
    );
    expect(config).toEqual({});
    expect(configuredProviders(config)).toEqual([]);
    expect(warnings.join("\n")).toContain("no config at");
  });

  it("reads the providers and the default model, in the file's order", async () => {
    const path = await scratchConfig({
      providers: [
        localProvider({ id: "second" }),
        localProvider({ id: "first" }),
      ],
      defaultModel: "second:m2",
    });
    const config = await readConfig(path, () => undefined);
    expect(configuredProviders(config).map((provider) => provider.id)).toEqual([
      "second",
      "first",
    ]);
    // The `provider:model` form is what the config file and the GUI both write.
    expect(configDefaultModel(config)).toEqual({
      provider: "second",
      modelId: "m2",
    });
  });
});
