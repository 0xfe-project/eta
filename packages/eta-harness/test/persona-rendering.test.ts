import type { PersonaCard } from "@eta/core";
import { Kernel, Runner } from "@eta/core";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { renderActivePersona, renderPersonaBlock } from "../src/index";
function card(id: string, content = `${id} body`): PersonaCard {
  return { id, name: id, content };
}
describe("persona renderer", () => {
  it("renderPersonaBlock is pure and reports misses in order", () => {
    const cards = new Map([
      ["x", card("x", "ex")],
      ["y", card("y", "why")],
    ]);
    expect(renderPersonaBlock(["y", "x", "z"], cards)).toEqual({
      text: "why\n\nex",
      missing: ["z"],
    });
    expect(renderPersonaBlock([], cards)).toEqual({ text: "", missing: [] });
  });
});
// Every point below is a line of eta-agent's persona.ts, checked one by one.
describe("persona fidelity against eta-agent's persona.ts", () => {
  it("trims each card and joins the block with a blank line", () => {
    const cards = new Map([
      ["a", card("a", "  first card  ")],
      ["b", card("b", "\nsecond card\n")],
    ]);
    expect(renderPersonaBlock(["a", "b"], cards)).toEqual({
      text: "first card\n\nsecond card",
      missing: [],
    });
  });

  it("reports misses in the requested order and renders nothing for them", () => {
    const cards = new Map([["a", card("a", "A")]]);
    expect(renderPersonaBlock(["x", "a", "y"], cards)).toEqual({
      text: "A",
      missing: ["x", "y"],
    });
  });

  it("an empty name list renders nothing and reports nothing", () => {
    expect(renderPersonaBlock([], new Map())).toEqual({
      text: "",
      missing: [],
    });
  });

  it("the active persona is the block the prompt owner composes with", async () => {
    const kernel = Kernel.create({
      config: { model: { provider: "p", modelId: "m" } },
    });
    const fake = fakeModels([assistantMessage()]);
    kernel.persona.loadCards([
      card("Executor", "You are the executor."),
      card("Other", "You are someone else."),
    ]);
    kernel.persona.setActive(["Executor"]);
    // The runner puts this in the request verbatim; composing it into a prompt is
    // the prompt layer's job (the harness's composer puts persona right after the
    // base prompt, where a provider cache keeps it).
    const block = renderActivePersona(kernel.persona).text;
    expect(block).toContain("You are the executor.");
    expect(block).not.toContain("You are someone else.");
    const runner = new Runner(kernel, {
      models: fake,
      systemPrompt: `base prompt\n\n${block}`,
    });
    kernel.inject({
      role: "user",
      content: [{ type: "text", text: "go" }],
      timestamp: 0,
    });
    await runner.run();

    expect(fake.calls[0]!.context.systemPrompt).toBe(`base prompt\n\n${block}`);
    void kernel.dispose();
  });

  it("a missing active persona is reported, and the rest of the block stays", () => {
    const kernel = Kernel.create({
      config: { model: { provider: "p", modelId: "m" } },
    });
    kernel.persona.loadCards([card("Executor", "still here")]);
    kernel.persona.setActive(["Ghost", "Executor"]);
    const rendered = renderActivePersona(kernel.persona);
    expect(rendered.missing).toEqual(["Ghost"]);
    expect(rendered.text).toContain("still here");
    void kernel.dispose();
  });

  it("the runner adds no prompt text of its own", async () => {
    const kernel = Kernel.create({
      config: { model: { provider: "p", modelId: "m" } },
    });
    const fake = fakeModels([assistantMessage()]);
    kernel.persona.loadCards([card("Executor", "persona text")]);
    kernel.persona.setActive(["Executor"]);
    const runner = new Runner(kernel, { models: fake, systemPrompt: "base" });
    kernel.inject({
      role: "user",
      content: [{ type: "text", text: "go" }],
      timestamp: 0,
    });
    await runner.run();
    // Core owns no model-visible words, persona included: what the caller passed is
    // exactly what the provider sees.
    expect(fake.calls[0]!.context.systemPrompt).toBe("base");
    void kernel.dispose();
  });
});
