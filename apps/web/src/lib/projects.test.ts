import { describe, expect, it } from "@rstest/core";
import { machineView } from "@/test-product";
import {
  folderName,
  joinPath,
  parentPath,
  pathCrumbs,
  projectPlace,
  shortenPath,
} from "./projects";

// Where a project is, as the sidebar and the header write it.

const machines = [
  machineView({ id: "m1", name: "这台", home: "/Users/me" }),
  machineView({
    id: "m2",
    kind: "daemon",
    name: "gpu-box",
    home: "/home/eric",
  }),
  machineView({ id: "m3", kind: "daemon", name: "nas", home: null }),
];

describe("projectPlace", () => {
  it("is the bare path on the primary, ~ only when asked for short", () => {
    const project = { machineId: "m1", path: "/Users/me/Desktop/eta" };
    expect(projectPlace(project, machines)).toBe("/Users/me/Desktop/eta");
    expect(projectPlace(project, machines, { short: true })).toBe(
      "~/Desktop/eta",
    );
    expect(
      projectPlace({ machineId: "m1", path: "/Users/me" }, machines, {
        short: true,
      }),
    ).toBe("~");
  });

  it("names the machine when it is not the primary, and shortens with that machine's home", () => {
    const project = { machineId: "m2", path: "/home/eric/training" };
    expect(projectPlace(project, machines)).toBe("gpu-box:/home/eric/training");
    expect(projectPlace(project, machines, { short: true })).toBe(
      "gpu-box:~/training",
    );
    // The primary's home means nothing on another machine.
    expect(
      projectPlace({ machineId: "m2", path: "/Users/me/eta" }, machines, {
        short: true,
      }),
    ).toBe("gpu-box:/Users/me/eta");
  });

  it("keeps the path whole on a machine that has not said its home", () => {
    expect(
      projectPlace({ machineId: "m3", path: "/srv/backup" }, machines, {
        short: true,
      }),
    ).toBe("nas:/srv/backup");
  });

  it("is the bare path while the project's machine is not in the list yet", () => {
    const project = { machineId: "m9", path: "/home/eric/training" };
    expect(projectPlace(project, machines, { short: true })).toBe(
      "/home/eric/training",
    );
    expect(projectPlace(project, [])).toBe("/home/eric/training");
  });
});

describe("Windows paths", () => {
  const home = "C:\\Users\\me";

  it("finds parents and joins children with backslashes", () => {
    expect(parentPath("C:\\")).toBeUndefined();
    expect(parentPath("C:\\Users\\me")).toBe("C:\\Users");
    expect(parentPath("C:\\Users")).toBe("C:\\");
    expect(joinPath("C:\\", "Users")).toBe("C:\\Users");
    expect(joinPath("C:\\Users\\me", "Desktop")).toBe("C:\\Users\\me\\Desktop");
  });

  it("keeps the drive reachable above the home", () => {
    expect(pathCrumbs(home, home)).toEqual([
      { name: "C:", path: "C:\\" },
      { name: "~", path: home },
    ]);
    expect(pathCrumbs("C:\\Users\\me\\Desktop", home)).toEqual([
      { name: "C:", path: "C:\\" },
      { name: "~", path: home },
      { name: "Desktop", path: "C:\\Users\\me\\Desktop" },
    ]);
  });

  it("shortens project paths inside the home", () => {
    expect(folderName("C:\\Users\\me\\Desktop\\")).toBe("Desktop");
    expect(shortenPath("C:\\Users\\me\\Desktop\\eta", home)).toBe(
      "~/Desktop/eta",
    );
    expect(shortenPath("C:\\Users\\Public", home)).toBe("C:\\Users\\Public");
  });
});

describe("POSIX paths", () => {
  it("keeps a backslash in a POSIX directory name", () => {
    expect(folderName("/Users/me/foo\\bar")).toBe("foo\\bar");
    expect(folderName("/")).toBe("/");
  });

  it("keeps the filesystem root reachable above the home", () => {
    expect(pathCrumbs("/Users/me", "/Users/me")).toEqual([
      { name: "/", path: "/" },
      { name: "~", path: "/Users/me" },
    ]);
    expect(pathCrumbs("/Users/me/Desktop", "/Users/me")).toEqual([
      { name: "/", path: "/" },
      { name: "~", path: "/Users/me" },
      { name: "Desktop", path: "/Users/me/Desktop" },
    ]);
    expect(pathCrumbs("/Volumes/Data", "/Users/me")).toEqual([
      { name: "/", path: "/" },
      { name: "Volumes", path: "/Volumes" },
      { name: "Data", path: "/Volumes/Data" },
    ]);
  });
});
