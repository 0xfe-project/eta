import { describe, expect, it } from "vitest";
import { machineView } from "@/test-product";
import { folderName, projectPlace } from "./projects";

// Where a project is, as the sidebar and the header write it: the path as its machine writes it
// comes from the host (`display`); nothing here takes a path apart beyond its last name.

const machines = [
  machineView({ id: "m1", name: "这台", home: "/Users/me" }),
  machineView({
    id: "m2",
    kind: "daemon",
    name: "gpu-box",
    home: "/home/eric",
  }),
  machineView({
    id: "m3",
    kind: "daemon",
    name: "win",
    home: "C:\\Users\\Ada",
  }),
];

describe("projectPlace", () => {
  it("is the bare path on the primary, the machine's display only when asked for short", () => {
    const project = {
      machineId: "m1",
      path: "/Users/me/Desktop/eta",
      display: "~/Desktop/eta",
    };
    expect(projectPlace(project, machines)).toBe("/Users/me/Desktop/eta");
    expect(projectPlace(project, machines, { short: true })).toBe(
      "~/Desktop/eta",
    );
  });

  it("names the machine when it is not the primary", () => {
    const project = {
      machineId: "m2",
      path: "/home/eric/training",
      display: "~/training",
    };
    expect(projectPlace(project, machines)).toBe("gpu-box:/home/eric/training");
    expect(projectPlace(project, machines, { short: true })).toBe(
      "gpu-box:~/training",
    );
    const windows = {
      machineId: "m3",
      path: "C:\\Users\\Ada\\code",
      display: "~\\code",
    };
    expect(projectPlace(windows, machines, { short: true })).toBe(
      "win:~\\code",
    );
  });

  it("keeps the bare path while the machine list has not arrived", () => {
    expect(
      projectPlace(
        { machineId: "m9", path: "/srv/x", display: "/srv/x" },
        machines,
        { short: true },
      ),
    ).toBe("/srv/x");
  });
});

describe("folderName", () => {
  it("is the last name, whichever separator the machine uses", () => {
    expect(folderName("/Users/me/eta/")).toBe("eta");
    expect(folderName("C:\\Users\\Ada\\code")).toBe("code");
    expect(folderName("/")).toBe("/");
    expect(folderName("D:\\")).toBe("D:");
  });
});
