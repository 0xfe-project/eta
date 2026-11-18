import { describe, expect, it } from "vitest";
import { PathRules } from "../src";

const posix = new PathRules("posix", "/home/ada");
const win = new PathRules("win32", "C:\\Users\\Ada");

const resolved = (rules: PathRules, raw: string) => {
  const out = rules.resolve(raw);
  return out.ok ? out.path : out.failure.code;
};

describe("a POSIX machine's paths", () => {
  it("expands ~ to its home and normalizes by the text", () => {
    expect(resolved(posix, "~")).toBe("/home/ada");
    expect(resolved(posix, "~/x")).toBe("/home/ada/x");
    expect(resolved(posix, " /srv//a/./b/../c/ ")).toBe("/srv/a/c");
    expect(resolved(posix, "/")).toBe("/");
  });

  it("refuses what is relative, a drive or a share, and NUL", () => {
    expect(resolved(posix, "code/eta")).toBe("not_absolute");
    expect(resolved(posix, "~ada/x")).toBe("not_absolute");
    expect(resolved(posix, "C:\\Users")).toBe("invalid");
    expect(resolved(posix, "C:/Users")).toBe("invalid");
    expect(resolved(posix, "\\\\server\\share")).toBe("invalid");
    expect(resolved(posix, "/a\0b")).toBe("invalid");
    expect(resolved(posix, "  ")).toBe("invalid");
  });

  it("keeps a backslash as part of a name, which it is there", () => {
    expect(resolved(posix, "/tmp/a\\b")).toBe("/tmp/a\\b");
  });

  it("shortens under the home only, and crumbs start at ~ there", () => {
    expect(posix.display("/home/ada")).toBe("~");
    expect(posix.display("/home/ada/Developer/eta")).toBe("~/Developer/eta");
    expect(posix.display("/home/adam")).toBe("/home/adam");
    expect(posix.crumbs("/home/ada/Developer/eta")).toEqual([
      { name: "~", path: "/home/ada" },
      { name: "Developer", path: "/home/ada/Developer" },
      { name: "eta", path: "/home/ada/Developer/eta" },
    ]);
    expect(posix.crumbs("/srv/a")).toEqual([
      { name: "/", path: "/" },
      { name: "srv", path: "/srv" },
      { name: "a", path: "/srv/a" },
    ]);
    expect(posix.parent("/")).toBeNull();
    expect(posix.parent("/srv")).toBe("/");
  });

  it("takes a name that is a file name everywhere (valid-filename), even on POSIX", () => {
    expect(posix.validName("new thing")).toBe(true);
    // Fine on Linux, not on Windows or macOS's Finder: refused, so the directory can travel.
    expect(posix.validName("a:b")).toBe(false);
    expect(posix.validName("con")).toBe(false);
    expect(posix.validName("a/b")).toBe(false);
    expect(posix.validName("..")).toBe(false);
  });
});

describe("a Windows machine's paths", () => {
  it("takes either slash after a drive, and writes backslashes", () => {
    expect(resolved(win, "C:\\Users\\Ada\\code")).toBe("C:\\Users\\Ada\\code");
    expect(resolved(win, "c:/Users/Ada/code/")).toBe("c:\\Users\\Ada\\code");
    expect(resolved(win, "D:")).toBe("D:\\");
    expect(resolved(win, "D:\\")).toBe("D:\\");
    expect(resolved(win, "D:\\a\\..\\b")).toBe("D:\\b");
  });

  it("expands ~ with either separator", () => {
    expect(resolved(win, "~")).toBe("C:\\Users\\Ada");
    expect(resolved(win, "~\\code")).toBe("C:\\Users\\Ada\\code");
    expect(resolved(win, "~/code/eta")).toBe("C:\\Users\\Ada\\code\\eta");
  });

  it("takes a UNC share, and refuses a path with no drive", () => {
    expect(resolved(win, "\\\\nas\\share\\proj")).toBe("\\\\nas\\share\\proj");
    expect(resolved(win, "//nas/share/proj")).toBe("\\\\nas\\share\\proj");
    expect(resolved(win, "\\\\nas")).toBe("invalid");
    expect(resolved(win, "/home/ada")).toBe("invalid");
    expect(resolved(win, "\\Users")).toBe("invalid");
    expect(resolved(win, "code")).toBe("not_absolute");
    expect(resolved(win, "C:\\a<b")).toBe("invalid");
  });

  it("shortens under the home whatever the case, and crumbs reach the drive", () => {
    expect(win.display("c:\\users\\ada\\code")).toBe("~\\code");
    expect(win.display("D:\\work")).toBe("D:\\work");
    expect(win.crumbs("C:\\Users\\Ada\\code\\eta")).toEqual([
      { name: "~", path: "C:\\Users\\Ada" },
      { name: "code", path: "C:\\Users\\Ada\\code" },
      { name: "eta", path: "C:\\Users\\Ada\\code\\eta" },
    ]);
    expect(win.crumbs("D:\\work\\eta")).toEqual([
      { name: "D:", path: "D:\\" },
      { name: "work", path: "D:\\work" },
      { name: "eta", path: "D:\\work\\eta" },
    ]);
    expect(win.crumbs("\\\\nas\\share\\p")).toEqual([
      { name: "\\\\nas\\share", path: "\\\\nas\\share\\" },
      { name: "p", path: "\\\\nas\\share\\p" },
    ]);
    expect(win.parent("D:\\")).toBeNull();
    expect(win.parent("D:\\work")).toBe("D:\\");
  });

  it("refuses the names Windows refuses", () => {
    for (const name of [
      "a\\b",
      "a:b",
      "what?",
      "con",
      "NUL.txt",

      "lpt1",
    ])
      expect(win.validName(name), name).toBe(false);
    expect(win.validName("console")).toBe(true);
  });
});
