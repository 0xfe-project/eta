import type { Group } from "@/queries/chat";
import { describe, expect, it } from "@rstest/core";
import { folderSections, matchesQuery } from "./folder-sections";

const group = (
  id: string,
  name: string,
  cwd: string,
  at = "2026-10-17T00:00:00Z",
) =>
  ({
    id,
    name,
    kind: "group",
    cwd,
    updated_at: at,
    last_message_at: at,
  }) as unknown as Group;

describe("侧边栏按目录分组", () => {
  it("puts each conversation under the folder it works in, folders by path", () => {
    const sections = folderSections([
      group("g1", "装修", "/Users/me/work/house"),
      group("g2", "装配", "/Users/me/Desktop/eta"),
      group("g3", "重构", "/Users/me/Desktop/eta"),
    ]);
    expect(sections.map((s) => [s.path, s.label, s.groups.length])).toEqual([
      ["/Users/me/Desktop/eta", "eta", 2],
      ["/Users/me/work/house", "house", 1],
    ]);
  });

  it("widens a label until two folders cannot be confused", () => {
    const sections = folderSections([
      group("g1", "a", "/Users/me/work/api"),
      group("g2", "b", "/Users/me/side/api"),
    ]);
    expect(sections.map((s) => s.label).sort()).toEqual([
      "side/api",
      "work/api",
    ]);
  });

  it("keeps conversations with no folder in their own section, last", () => {
    const sections = folderSections([
      group("g1", "无家可归", ""),
      group("g2", "装配", "/Users/me/Desktop/eta"),
    ]);
    expect(sections.at(-1)?.unbound).toBe(true);
    expect(sections.at(-1)?.groups.map((g) => g.id)).toEqual(["g1"]);
    expect(sections[0]?.unbound).toBe(false);
  });

  it("orders a folder's conversations by what moved last", () => {
    const sections = folderSections([
      group("old", "旧的", "/p", "2026-10-01T00:00:00Z"),
      group("new", "新的", "/p", "2026-10-17T00:00:00Z"),
    ]);
    expect(sections[0]?.groups.map((g) => g.id)).toEqual(["new", "old"]);
  });

  it("searches a conversation by its name or its folder", () => {
    const eta = group("g1", "装配", "/Users/me/Desktop/eta");
    expect(matchesQuery(eta, "装")).toBe(true);
    expect(matchesQuery(eta, "desktop")).toBe(true);
    expect(matchesQuery(eta, "house")).toBe(false);
    expect(matchesQuery(eta, "  ")).toBe(true);
  });
});
