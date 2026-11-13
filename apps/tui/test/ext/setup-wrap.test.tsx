/**
 * How the agents step's intro wraps: the model's name it names stays on one line when the sentence
 * is too wide for the layer, and the sentence stays on one line when the layer has room for it.
 */
import type { TargetState, WireState } from "../../src/connection/types";
import type { ShellContext } from "../../src/extensions/types";
import { describe, expect, it } from "vitest";
import { SetupLayer } from "../../src/ext/setup/setup-layer";
import { RunningShellContext } from "../../src/extensions/react";
import { renderKit } from "../ext-support/render-kit";
import { fakeWire } from "../ui-support/fake-wire";
import { flush, plain } from "../ui-support/render";

const MODEL_LABEL = "Codex / GPT 5.6 Luna";

function target(sections: Record<string, unknown>): TargetState {
  return { sections, revisions: {}, version: 1 };
}

/** The screen's lines, with the spaces a name is kept together by read as the spaces they look like. */
async function agentsStepLines(
  columns: number,
  locale: "en" | "zh",
): Promise<string[]> {
  const wire = fakeWire({
    mounted: [{ name: "providers", source: "bundled" }] as WireState["mounted"],
    targets: {
      providers: target({
        config: {
          providers: [
            {
              id: "codex",
              kind: "openai-codex",
              hasApiKey: false,
              models: [{ id: "gpt-5.6-luna", name: "GPT 5.6 Luna" }],
            },
          ],
          revision: "r",
        },
      }),
      personas: target({ cards: [] }),
      agents: target({ list: [] }),
    },
  });
  const ctx = {
    wire,
    locale,
    notify: () => undefined,
  } as unknown as ShellContext;
  const r = renderKit(
    <RunningShellContext value={ctx}>
      <SetupLayer handle={{ close: () => undefined }} />
    </RunningShellContext>,
    { columns, locale },
  );
  await flush();
  return plain(r).replaceAll(" ", " ").split("\n");
}

describe("the agents step's intro", () => {
  // 80 columns leave the text 76 inside the layer's border and padding; the Chinese sentence
  // takes 80, so it wraps, and the break would otherwise fall at the space before "Luna".
  it("moves the whole model name to the next line when the Chinese sentence does not fit", async () => {
    const lines = await agentsStepLines(80, "zh");
    const intro = lines.findIndex((line) => line.includes("每张 persona 卡"));
    expect(intro).toBeGreaterThanOrEqual(0);
    expect(lines[intro]).not.toContain("Codex");
    expect(lines[intro + 1]).toContain(`${MODEL_LABEL}。`);
  });
});
