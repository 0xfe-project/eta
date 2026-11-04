import type { ProjectChoice } from "./use-project-choice";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { act, useState } from "react";
import { setWire } from "@/lib/wire";
import { machineView, productHost, projectView } from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";
import { ProjectField } from "./project-field";
import { useResolveProject } from "./use-project-choice";

const onBrowse = rstest.fn();

afterEach(async () => {
  await cleanup();
  setWire(undefined);
  onBrowse.mockClear();
});

const primary = machineView({ id: "m1", name: "主机", kind: "primary" });
const machine = (
  id: string,
  status: "online" | "offline" | "pending" | "revoked",
) => machineView({ id, name: id, kind: "daemon", status });

let resolve: ReturnType<typeof useResolveProject>["resolve"] | undefined;
let current: ProjectChoice | undefined;

function Harness({ initial }: { initial?: Partial<ProjectChoice> }) {
  const [choice, setChoice] = useState<ProjectChoice>({
    projectId: "",
    path: "/srv/app",
    ...initial,
  });
  resolve = useResolveProject().resolve;
  current = choice;
  return (
    <ProjectField choice={choice} onChange={setChoice} onBrowse={onBrowse} />
  );
}

/** Radix Select opens on a key press (happy-dom has no pointer capture for a click). */
async function openProjects() {
  const trigger = document.querySelector<HTMLElement>("#new-project")!;
  await act(async () => {
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
  });
  return trigger;
}

const options = () =>
  [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(
    (option) => option.textContent,
  );

async function pick(text: string) {
  await openProjects();
  const option = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((candidate) => candidate.textContent === text);
  expect(option, text).toBeDefined();
  await act(async () => option!.click());
}

describe("添加目录时选机器", () => {
  it("offers no list while the primary is the only usable machine: a button goes to the picker", async () => {
    productHost({
      machines: [
        primary,
        machine("m2", "pending"),
        machine("m3", "offline"),
        machine("m4", "revoked"),
      ],
    });
    await mount(<Harness />);
    await flush();
    const field = document.querySelector<HTMLElement>("#new-project")!;
    expect(field.tagName).toBe("BUTTON");
    expect(field.textContent).toBe("app/srv/app");
    expect(document.querySelector('[role="combobox"]')).toBeNull();
    await click(field);
    expect(onBrowse).toHaveBeenCalledWith();
  });

  it("asks in the project list, one option per online machine, the primary first", async () => {
    productHost({
      machines: [
        primary,
        machine("m2", "online"),
        machine("m3", "offline"),
        machine("m4", "pending"),
      ],
    });
    await mount(<Harness />);
    await flush();
    const trigger = await openProjects();
    // The field shows what was chosen; the options after it go and choose another.
    expect(trigger.textContent).toBe("app/srv/app");
    expect(options()).toEqual([
      "app/srv/app",
      "在 主机 上添加目录…",
      "在 m2 上添加目录…",
    ]);
    expect(document.querySelectorAll('[role="combobox"]')).toHaveLength(1);
  });

  it("goes to the picker on the machine its option names, and leaves the choice alone", async () => {
    productHost({
      machines: [primary, machine("m2", "online")],
      projects: [projectView({ id: "p1" })],
    });
    await mount(<Harness />);
    await flush();
    await pick("在 m2 上添加目录…");
    expect(onBrowse).toHaveBeenLastCalledWith("m2");
    expect(current).toEqual({ projectId: "", path: "/srv/app" });
    await pick("在 主机 上添加目录…");
    expect(onBrowse).toHaveBeenLastCalledWith("m1");
  });

  it("with one machine goes to the picker without naming one", async () => {
    productHost({
      machines: [primary],
      projects: [projectView({ id: "p1" })],
    });
    await mount(<Harness />);
    await flush();
    await pick("添加目录…");
    expect(onBrowse).toHaveBeenLastCalledWith(undefined);
  });

  it("adds what was chosen on the machine it was chosen on", async () => {
    const fake = productHost({
      machines: [primary, machine("m2", "online")],
      projects: [projectView({ id: "p1" })],
    });
    fake.handle("projects.create", (args) => ({
      project: projectView({
        id: "made",
        path: (args as { path: string }).path,
      }),
      existed: false,
    }));
    await mount(<Harness initial={{ machineId: "m2" }} />);
    await flush();
    await act(async () => {
      await resolve!(current!, undefined, null);
    });
    expect(fake.calls.at(-1)).toMatchObject({
      target: "projects",
      action: "create",
      args: { path: "/srv/app", machineId: "m2" },
    });
  });
});

describe("项目列表里的机器", () => {
  const projects = [
    projectView({ id: "eta", machineId: "m1", path: "/srv/eta" }),
    projectView({ id: "eta2", name: "eta", machineId: "m2", path: "/srv/eta" }),
    projectView({ id: "ios", machineId: "m3", path: "/Users/me/ios" }),
  ];

  it("names the machine of a project that is not on the primary, and says when it is offline", async () => {
    productHost({
      machines: [primary, machine("m2", "online"), machine("m3", "offline")],
      projects,
    });
    await mount(<Harness initial={{ projectId: "eta" }} />);
    await flush();
    await openProjects();
    expect(options()).toEqual([
      "eta/srv/eta",
      "etam2:/srv/eta",
      "iosm3:/Users/me/ios（离线）",
      "在 主机 上添加目录…",
      "在 m2 上添加目录…",
    ]);
  });

  it("is the bare path while the machines have not said, with the one add option", async () => {
    productHost({ projects });
    await mount(<Harness initial={{ projectId: "eta" }} />);
    await flush();
    await openProjects();
    expect(options()).toEqual([
      "eta/srv/eta",
      "eta/srv/eta",
      "ios/Users/me/ios",
      "添加目录…",
    ]);
  });

  it("shows the chosen project's place once, in the select", async () => {
    productHost({
      machines: [primary, machine("m2", "online")],
      projects,
    });
    await mount(<Harness />);
    await flush();
    await pick("etam2:/srv/eta");
    expect(current).toMatchObject({ projectId: "eta2" });
    const field = document.querySelector("#new-project")!.parentElement!;
    expect(field.textContent!.split("/srv/eta")).toHaveLength(2);
    expect(field.querySelector("input")).toBeNull();
  });
});
