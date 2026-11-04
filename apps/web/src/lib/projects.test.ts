import { describe, expect, it } from "@rstest/core";
import { machineView } from "@/test-product";
import { projectPlace } from "./projects";

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

  it("tells one path on two machines apart", () => {
    const path = "/Users/me/Desktop/eta";
    expect(projectPlace({ machineId: "m1", path }, machines)).not.toBe(
      projectPlace({ machineId: "m2", path }, machines),
    );
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
