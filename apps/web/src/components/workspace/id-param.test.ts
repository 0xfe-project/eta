import { describe, expect, it } from "@rstest/core";
import { idParam } from "./id-param";

// `?group=null` is a state a URL can reach, and once it is there every link the panel draws
// carries it: a string is truthy, so `group ?? undefined` passed it on instead of dropping it.
describe("an id in the URL", () => {
  it("reads the word null as no id at all", () => {
    expect(idParam.parse("null")).toBeNull();
    expect(idParam.parse("undefined")).toBeNull();
    expect(idParam.parse("")).toBeNull();
  });

  it("keeps an id", () => {
    expect(idParam.parse("ef2c46eb-4c39-413e-b79a-6aeb621c4d72")).toBe(
      "ef2c46eb-4c39-413e-b79a-6aeb621c4d72",
    );
  });

  it("writes no id as an empty value", () => {
    expect(idParam.serialize(null)).toBe("");
    expect(idParam.serialize("t1")).toBe("t1");
  });
});
