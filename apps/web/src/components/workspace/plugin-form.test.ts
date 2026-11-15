import type { PluginFieldView } from "@eta/client-contracts";
import { parseConfigFields } from "@eta/client-contracts/plugin-fields";
import { describe, expect, it } from "@rstest/core";
import { changes, draftOf, formState } from "./plugin-form";

/** A field as the host sends it, from what a manifest declares. */
function viewOf(
  spec: Record<string, unknown>,
  saved: Partial<PluginFieldView> = {},
): PluginFieldView {
  const { fields, problems } = parseConfigFields({ f: spec });
  expect(problems).toEqual([]);
  return {
    ...fields[0]!,
    set: false,
    value: null,
    level: fields[0]!.agent,
    levels: [fields[0]!.agent],
    issue: null,
    ...saved,
  } as PluginFieldView;
}

/** What the form says about one field holding `draft`. */
const issueOf = (field: PluginFieldView, draft: string) =>
  formState([field], { [field.name]: draft }).issues[field.name];

const options = [
  { value: "a", label: "A" },
  { value: "b", label: "B" },
];

describe("what the form says, by the host's rules", () => {
  it("reads a number from what was typed", () => {
    const field = viewOf({ type: "number", int: true, min: 1, max: 10 });
    expect(issueOf(field, "4")).toBeUndefined();
    expect(issueOf(field, "2.5")?.code).toBe("int");
    expect(issueOf(field, "0")).toEqual({ field: "f", code: "min", limit: 1 });
    expect(issueOf(field, "11")).toEqual({
      field: "f",
      code: "max",
      limit: 10,
    });
    expect(issueOf(field, "many")?.code).toBe("type");
  });

  it("takes a blank secret that is saved as one to keep", () => {
    const missing = viewOf({ type: "string", secret: true, required: true });
    expect(issueOf(missing, "")?.code).toBe("required");
    const saved = viewOf(
      { type: "string", secret: true, required: true, pattern: "^x$" },
      { set: true },
    );
    expect(issueOf(saved, "")).toBeUndefined();
    expect(issueOf(saved, "y")?.code).toBe("pattern");
  });

  it("can be saved while something required is missing, and not while something is wrong", () => {
    const fields = [viewOf({ type: "string", required: true })].map(
      (field, index) => ({ ...field, name: `f${index}` }),
    );
    const count = {
      ...viewOf({ type: "number", max: 5 }),
      name: "count",
    };
    const all = [...fields, count];
    expect(formState(all, { f0: "", count: "" })).toMatchObject({
      invalid: false,
      complete: false,
    });
    expect(formState(all, { f0: "x", count: "9" })).toMatchObject({
      invalid: true,
      complete: false,
    });
    expect(formState(all, { f0: "x", count: "3" })).toMatchObject({
      invalid: false,
      complete: true,
    });
  });
});

describe("what it sends", () => {
  it("starts from what is saved, then the default, and a secret blank", () => {
    expect(draftOf([viewOf({ type: "string", default: "d" })])).toEqual({
      f: "d",
    });
    expect(
      draftOf([
        viewOf({ type: "number", default: 3 }, { value: 5, set: true }),
      ]),
    ).toEqual({ f: "5" });
    expect(
      draftOf([viewOf({ type: "string", secret: true }, { set: true })]),
    ).toEqual({ f: "" });
    expect(draftOf([viewOf({ type: "boolean" })])).toEqual({ f: false });
    expect(
      draftOf([viewOf({ type: "select", multiple: true, options })]),
    ).toEqual({ f: [] });
  });

  it("sends what changed, as the field's type, and nothing else", () => {
    const number = viewOf({ type: "number" }, { value: 5, set: true });
    expect(changes([number], { f: "5" })).toEqual({});
    expect(changes([number], { f: "7" })).toEqual({ f: 7 });
    expect(changes([number], { f: "" })).toEqual({ f: null });
  });

  it("leaves a blank secret out, so what is saved stays", () => {
    const secret = viewOf({ type: "string", secret: true }, { set: true });
    expect(changes([secret], { f: "" })).toEqual({});
    expect(changes([secret], { f: "new" })).toEqual({ f: "new" });
  });

  it("saves a required value that is only a default on the screen", () => {
    const flag = viewOf({ type: "boolean", required: true });
    expect(changes([flag], { f: false })).toEqual({ f: false });
  });
});
