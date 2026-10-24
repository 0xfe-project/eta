import type { ProjectChoice } from "./use-project-choice";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
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

const chooseFolder = () =>
  [...document.querySelectorAll<HTMLElement>("button")].find(
    (button) => button.textContent === "选择目录…",
  );

describe("在桌面壳里选目录", () => {
  afterEach(() => {
    delete window.__ETA_HOST__;
  });

  /** A shell around the page, and a window that says `answer` to the folder dialog. */
  function shell(answer: { path: string | null } | "refused") {
    window.__ETA_HOST__ = {
      native: true,
      nativeApiBase: "http://127.0.0.1:5001",
      nativeToken: "launch-token",
    };
    globalThis.fetch = rstest.fn(async () =>
      answer === "refused"
        ? new Response("authentication_failed", { status: 401 })
        : new Response(JSON.stringify(answer)),
    ) as unknown as typeof globalThis.fetch;
  }

  it("fills the path the system dialog brought back", async () => {
    productHost({ machines: [primary] });
    shell({ path: "/Users/me/code/eta" });
    await mount(<Harness />);
    await flush();
    expect(chooseFolder()).toBeDefined();
    await act(async () => {
      chooseFolder()!.click();
      await flush();
    });
    expect(current!.path).toBe("/Users/me/code/eta");
  });

  it("leaves the typed path alone when the dialog is cancelled", async () => {
    productHost({ machines: [primary] });
    shell({ path: null });
    await mount(<Harness />);
    await flush();
    await act(async () => {
      chooseFolder()!.click();
      await flush();
    });
    expect(current!.path).toBe("/srv/app");
  });

  it("keeps the typed path working when the window refuses the call", async () => {
    productHost({ machines: [primary] });
    shell("refused");
    await mount(<Harness />);
    await flush();
    await act(async () => {
      chooseFolder()!.click();
      await flush();
    });
    expect(current!.path).toBe("/srv/app");
  });

  it("is not offered in a browser", async () => {
    productHost({ machines: [primary] });
    await mount(<Harness />);
    await flush();
    expect(chooseFolder()).toBeUndefined();
  });

  it("is not offered while the path would be added on another machine", async () => {
    productHost({ machines: [primary, machine("m2", "online")] });
    shell({ path: "/srv/elsewhere" });
    await mount(<Harness />);
    await flush();
    await pickMachine("m2");
    expect(chooseFolder()).toBeUndefined();
    await pickMachine("主机");
    expect(chooseFolder()).toBeDefined();
  });
});
