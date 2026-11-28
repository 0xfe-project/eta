import type { PersonaCard } from "@eta/core";
import { Kernel } from "@eta/core";
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
});
