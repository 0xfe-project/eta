import type { ProjectChoice } from "./use-project-choice";
import { afterEach, describe, expect, it } from "@rstest/core";
import { act, useState } from "react";
import { setWire } from "@/lib/wire";
import { machineView, productHost, projectView } from "@/test-product";
import { cleanup, flush, mount } from "@/test-render";
import { ProjectField } from "./project-field";
import { useResolveProject } from "./use-project-choice";

afterEach(async () => {
  await cleanup();
  setWire(undefined);
});

const primary = machineView({ id: "m1", name: "主机", kind: "primary" });
const machine = (
  id: string,
  status: "online" | "offline" | "pending" | "revoked",
) => machineView({ id, name: id, kind: "daemon", status });

let resolve: ReturnType<typeof useResolveProject>["resolve"] | undefined;
let current: ProjectChoice | undefined;

function Harness() {
  const [choice, setChoice] = useState<ProjectChoice>({
    projectId: "",
    path: "/srv/app",
  });
  resolve = useResolveProject().resolve;
  current = choice;
  return <ProjectField choice={choice} onChange={setChoice} />;
}

/** Radix Select opens on a key press (happy-dom has no pointer capture for a click). */
async function openMachines() {
  const trigger = document.querySelector<HTMLElement>('[aria-label="机器"]')!;
  await act(async () => {
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
  });
  return trigger;
}

async function pickMachine(name: string) {
  await openMachines();
  const option = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((candidate) => candidate.textContent === name);
  expect(option, name).toBeDefined();
  await act(async () => option!.click());
}

describe("添加目录时选机器", () => {
  it("offers no choice while the primary is the only usable machine", async () => {
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
    expect(document.querySelector('[aria-label="机器"]')).toBeNull();
  });

  it("defaults to the primary and lists only online machines", async () => {
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
    const trigger = await openMachines();
    expect(trigger.textContent).toContain("主机");
    expect(
      [...document.querySelectorAll('[role="option"]')].map(
        (o) => o.textContent,
      ),
    ).toEqual(["主机", "m2"]);
  });

  it("adds the path on the chosen machine, and on the primary by leaving it out", async () => {
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
    await mount(<Harness />);
    await flush();
    await pickMachine("m2");
    expect(current).toMatchObject({ machineId: "m2" });
    await act(async () => {
      await resolve!(current!, undefined, null);
    });
    expect(fake.calls.at(-1)).toMatchObject({
      target: "projects",
      action: "create",
      args: { path: "/srv/app", machineId: "m2" },
    });
    await pickMachine("主机");
    await act(async () => {
      await resolve!(current!, undefined, null);
    });
    expect(fake.calls.at(-1)!.args).toEqual({ path: "/srv/app" });
  });
});
