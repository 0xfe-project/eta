import { describe, expect, it } from "@rstest/core";
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
