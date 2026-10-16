/**
 * A real conversation with the configured model — P0.6's acceptance, run for real.
 *
 * Skipped when there is no config file: CI has no accounts, and a test that needs someone's
 * credentials is a test that fails for the wrong reason. Point it elsewhere with
 * `ETA_SMOKE_CONFIG`, and pick a model with `ETA_SMOKE_MODEL` (`provider:model`).
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexAuthPath, CodexCredentialStore } from "../src/codex-auth";
import { configuredProviders, readConfig } from "../src/config";
import { configDefaultModel } from "../src/providers/config-types";
import { buildModels } from "../src/providers/runtime";

const configPath =
  process.env.ETA_SMOKE_CONFIG ?? join(homedir(), ".eta", "config.json");
const hasConfig = existsSync(configPath);

describe.skipIf(!hasConfig)("the configured model", () => {
  it("answers a question through the layer the kernel will use", async () => {
    const warnings: string[] = [];
    const config = await readConfig(configPath, (message) =>
      warnings.push(message),
    );
    const { models, failed } = await buildModels(configuredProviders(config), {
      credentials: new CodexCredentialStore(codexAuthPath(configPath)),
      warn: (message) => warnings.push(message),
    });
    expect(
      models,
      `no model layer was built: ${warnings.join(" | ")}`,
    ).toBeDefined();
    if (failed.length > 0)
      console.log(`[smoke] unusable providers: ${JSON.stringify(failed)}`);

    const chosen = process.env.ETA_SMOKE_MODEL ?? undefined;
    const target =
      chosen === undefined
        ? configDefaultModel(config)
        : {
            provider: chosen.split(":")[0] ?? "",
            modelId: chosen.split(":").slice(1).join(":"),
          };
    expect(target, "the config names no default model").toBeDefined();
    const model = models?.getModel(
      target?.provider ?? "",
      target?.modelId ?? "",
    );
    expect(
      model,
      `${target?.provider}:${target?.modelId} is not in the layer`,
    ).toBeDefined();

    const answer = await models!.completeSimple(model!, {
      messages: [
        {
          role: "user",
          timestamp: Date.now(),
          content: [
            { type: "text", text: "Reply with exactly one word: pong" },
          ],
        },
      ],
    });
    const text = answer.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    console.log(
      `[smoke] ${model!.provider}:${model!.id} → ${text.slice(0, 200)}`,
    );
    expect(text.trim().length).toBeGreaterThan(0);
  }, 120_000);
});
