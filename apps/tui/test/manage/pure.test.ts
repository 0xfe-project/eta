/**
 * The pure parts of conversation management: which agent a typed name means, how the member
 * choice of `/new` moves, and the path of a directory inside another.
 */
import { describe, expect, it } from "vitest";

import { projectRow } from "../../src/ext/manage/new/rows";
import { childPath } from "../../src/ext/manage/paths";

describe("childPath", () => {
  it("joins with the separator the path already uses", () => {
    expect(childPath("/home/ada", "src")).toBe("/home/ada/src");
    expect(childPath("C:\\Users\\ada", "src")).toBe("C:\\Users\\ada\\src");
  });

  it("does not double a separator at a root", () => {
    expect(childPath("/", "home")).toBe("/home");
    expect(childPath("C:\\", "Users")).toBe("C:\\Users");
  });
});

describe("a project's line in the first step of /new", () => {
  const project = (machineId: string) => ({
    id: "p1",
    name: "site",
    path: "/home/me/site",
    machineId,
  });
  const machines = [
    { id: "m0", name: "desk" },
    { id: "m1", name: "build box" },
  ];

  it("adds the machine's name for a project on another machine", () => {
    expect(projectRow(project("m1"), machines, "m0")).toEqual({
      key: "p1",
      label: "site",
      note: "/home/me/site  build box",
    });
  });
});
