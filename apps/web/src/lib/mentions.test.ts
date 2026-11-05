import { describe, expect, it } from "@rstest/core";
import { en, zh } from "@/locales/resources";
import { composerTarget, mentionedMembers } from "./mentions";

const members = [
  { id: "a", name: "Aria" },
  { id: "b", name: "Bolt" },
];
describe("group recipients", () => {
  it("keeps explicit mention order, deduplicates, and leaves plain messages as context", () => {
    expect(mentionedMembers("Bolt 和 Aria 一起讨论", members)).toEqual([]);
    expect(mentionedMembers("@Bolt 看一下，@Aria 下一步", members)).toEqual([
      "b",
      "a",
    ]);
    expect(mentionedMembers("@Bolt @Aria @Bolt 请看一下", members)).toEqual([
      "b",
      "a",
    ]);
    expect(mentionedMembers("@所有人 请看一下", members)).toEqual(["a", "b"]);
    expect(mentionedMembers("@Bolt @所有人", members)).toEqual(["b", "a"]);
    expect(mentionedMembers("@AriaPlus 以及 email@Bolt", members)).toEqual([]);
  });
  it("handles spaces and punctuation in names, and disambiguates duplicate names", () => {
    expect(
      mentionedMembers("@Foo Bar @C++ 请审阅", [
        { id: "x", name: "Foo Bar" },
        { id: "y", name: "C++" },
      ]),
    ).toEqual(["x", "y"]);
    const same = [
      { id: "123456-a", name: "助手" },
      { id: "654321-b", name: "助手" },
    ];
    expect(mentionedMembers("@助手 看看", same)).toEqual([]);
    expect(mentionedMembers("@助手·654321 看看", same)).toEqual(["654321-b"]);
  });
});

describe("who a draft goes to", () => {
  const steward = members[0];
  const target = (text: string, sticky?: "everyone" | string[]) =>
    composerTarget({ text, members, steward, sticky });
  const outside = { id: "s", name: "Steward" };

  it("leaves an empty group choice to the host, naming the steward only for show", () => {
    expect(target("你好")).toEqual({
      kind: "steward",
      ids: ["a"],
      mentions: [],
      sticky: undefined,
    });
    expect(
      composerTarget({
        text: "你好",
        members,
        steward: undefined,
        sticky: undefined,
      }),
    ).toEqual({ kind: "none", ids: [], mentions: [], sticky: undefined });
  });

  it("carries a kept choice, and resolves everyone against the members of the moment", () => {
    expect(target("你好", ["b"])).toEqual({
      kind: "members",
      ids: ["b"],
      mentions: ["b"],
      sticky: ["b"],
    });
    expect(target("你好", "everyone")).toEqual({
      kind: "everyone",
      ids: ["a", "b"],
      mentions: ["a", "b"],
      sticky: "everyone",
    });
  });

  it("lets what is typed win, and keeps it", () => {
    expect(target("@Bolt @Aria 看", "everyone")).toEqual({
      kind: "members",
      ids: ["b", "a"],
      mentions: ["b", "a"],
      sticky: ["b", "a"],
    });
    expect(target("@所有人 看", ["b"])).toMatchObject({
      kind: "everyone",
      mentions: ["a", "b"],
      sticky: "everyone",
    });
    expect(target("@everyone 看", ["b"]).sticky).toBe("everyone");
  });

  it("clears the choice when only the steward is named, and keeps them when others are too", () => {
    expect(target("@Aria 看", ["b"])).toEqual({
      kind: "steward",
      ids: ["a"],
      mentions: ["a"],
      sticky: undefined,
    });
    expect(target("@Aria @Bolt 看").sticky).toEqual(["a", "b"]);
  });

  it("counts a steward who is not a member yet, whom only the host can add", () => {
    const composer = (text: string) =>
      composerTarget({ text, members, steward: outside, sticky: ["b"] });
    expect(composer("@Steward 看")).toEqual({
      kind: "steward",
      ids: ["s"],
      mentions: [],
      sticky: undefined,
    });
    expect(composer("@Steward @Aria 看").mentions).toEqual(["a"]);
  });

  it("filters out members who left, and falls back when nobody is left", () => {
    expect(target("你好", ["gone", "b"])).toMatchObject({
      ids: ["b"],
      mentions: ["b"],
      sticky: ["b"],
    });
    expect(target("你好", ["gone"])).toMatchObject({
      kind: "steward",
      mentions: [],
      sticky: undefined,
    });
    expect(
      composerTarget({
        text: "你好",
        members: [],
        steward,
        sticky: "everyone",
      }),
    ).toMatchObject({ kind: "steward", mentions: [], sticky: undefined });
  });
});

// `@everyone` as a written word: the label the menu shows after its "@" is the mention itself, in
// either language. This is the contract that broke once: a label carrying its own "@" produced
// "@@所有人", which the parser does not match (an "@" is not whitespace), so it woke nobody.
describe("what the everyone label writes", () => {
  for (const [language, bundle] of [
    ["zh", zh],
    ["en", en],
  ] as const) {
    it(`wakes everyone when the ${language} label is written`, () => {
      const label = (bundle.chat as { mentions: { everyoneCommand: string } })
        .mentions.everyoneCommand;
      expect(label.startsWith("@")).toBe(false);
      expect(mentionedMembers(`@${label} 看一下`, members)).toEqual(["a", "b"]);
    });
  }
});
