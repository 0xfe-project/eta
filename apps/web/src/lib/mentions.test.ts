import { describe, expect, it } from "@rstest/core";
import { en, zh } from "@/locales/resources";
import { mentionedMembers } from "./mentions";

const members = [
  { agent_id: "a", name: "Aria" },
  { agent_id: "b", name: "Bolt" },
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
        { agent_id: "x", name: "Foo Bar" },
        { agent_id: "y", name: "C++" },
      ]),
    ).toEqual(["x", "y"]);
    const same = [
      { agent_id: "123456-a", name: "助手" },
      { agent_id: "654321-b", name: "助手" },
    ];
    expect(mentionedMembers("@助手 看看", same)).toEqual([]);
    expect(mentionedMembers("@助手·654321 看看", same)).toEqual(["654321-b"]);
  });
});

// The picker writes "@" + the label it was given, so the labels are words, not mentions. This is
// the contract that broke once: a label carrying its own "@" produced "@@所有人", which the
// parser does not match (an "@" is not whitespace) — the item looked right and woke nobody.
describe("what the mention picker inserts", () => {
  for (const [language, bundle] of [
    ["zh", zh],
    ["en", en],
  ] as const) {
    it(`wakes everyone when the ${language} picker entry is inserted`, () => {
      const label = (bundle.chat as { mentions: { everyoneCommand: string } })
        .mentions.everyoneCommand;
      expect(label.startsWith("@")).toBe(false);
      expect(mentionedMembers(`@${label} 看一下`, members)).toEqual(["a", "b"]);
    });
  }
});
