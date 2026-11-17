import type { DirectoryEntry, ProjectResults } from "@eta/client-contracts";
import { posix, win32 } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  rstest,
} from "@rstest/core";
import { act } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { setWire } from "@/lib/wire";
import {
  agentView,
  machineView,
  productHost,
  projectView,
} from "@/test-product";
import { button, cleanup, click, flush, mount } from "@/test-render";
import { DirectoryPicker } from "./directory-picker";
import { useDirectoryBrowser } from "./use-directory-browser";
import { useWorkspaceStore } from "./workspace-store";

const entry = (
  name: string,
  fields: Partial<DirectoryEntry> = {},
): DirectoryEntry => ({
  name,
  hidden: name.startsWith("."),
  git: false,
  projectId: null,
  ...fields,
});

const HOME = "/home/me";
const WINDOWS_HOME = "C:\\Users\\me";
const tree: Record<string, DirectoryEntry[]> = {
  [HOME]: [entry(".config"), entry("Developer"), entry("Documents")],
  [`${HOME}/Developer`]: [
    entry("billing", { git: true }),
    entry("eta", { git: true, projectId: "p1" }),
    entry("notes"),
  ],
  [`${HOME}/Developer/notes`]: [],
  "/srv": [entry("data")],
};
const windowsTree: Record<string, DirectoryEntry[]> = {
  "C:\\": [entry("Users"), entry("Windows")],
  "C:\\Users": [entry("me")],
  [WINDOWS_HOME]: [entry("Desktop"), entry("Documents")],
  "C:\\Users\\me\\Desktop": [entry("eta")],
};

class Problem extends Error {
  readonly problem: { code: string };
  constructor(code: string) {
    super(code);
    this.problem = { code };
  }
}

const primary = machineView({ id: "m1", name: "主机", kind: "primary" });

/** A machine with `tree` on it, and `failing` as the paths that answer with a problem. */
function machineHost({
  machines = [primary],
  projects = [] as ReturnType<typeof projectView>[],
  failing = {} as Record<string, string>,
  home = HOME,
  directories = tree,
} = {}) {
  const fake = productHost({
    machines,
    projects,
    agents: [agentView({ id: "a1", name: "乐子人" })],
  });
  fake.handle("projects.directories", (raw) => {
    const { path = home } = raw as { path?: string };
    const pathModule = /^[a-z]:[\\/]/i.test(home) ? win32 : posix;
    const asked = pathModule.resolve(
      path.startsWith("~") ? `${home}${path.slice(1)}` : path,
    );
    const code = failing[asked];
    if (code !== undefined) throw new Problem(code);
    const entries = directories[asked];
    if (entries === undefined) throw new Problem("not_found");
    const result: ProjectResults["directories"] = {
      path: asked,
      home,
      parent:
        pathModule.dirname(asked) === asked ? null : pathModule.dirname(asked),
      entries,
      truncated: false,
    };
    return result;
  });
  return fake;
}

const onProject = rstest.fn();

function Picker({
  machineId,
  start,
}: {
  machineId: string | undefined;
  start: string | undefined;
}) {
  const browser = useDirectoryBrowser({ machineId, path: start });
  return <DirectoryPicker browser={browser} onProject={onProject} />;
}

async function open({
  machineId,
  start,
}: {
  machineId?: string;
  start?: string;
} = {}) {
  const view = await mount(
    <Dialog open>
      <DialogContent>
        <Picker machineId={machineId} start={start} />
      </DialogContent>
    </Dialog>,
  );
  await flush();
  return view;
}

const rows = () =>
  [...document.querySelectorAll<HTMLElement>("ul button")].map(
    (row) => row.textContent,
  );
const row = (name: string) =>
  [...document.querySelectorAll<HTMLElement>("ul button")].find((candidate) =>
    candidate.textContent?.startsWith(name),
  );
const crumbs = () =>
  [...document.querySelectorAll<HTMLElement>("nav button")].map(
    (crumb) => crumb.textContent,
  );
const crumb = (name: string) =>
  [...document.querySelectorAll<HTMLElement>("nav button")].find(
    (candidate) => candidate.textContent === name,
  );
const pathBox = () =>
  document.querySelector<HTMLInputElement>('input[aria-label="目录路径"]');
const filterBox = () =>
  document.querySelector<HTMLInputElement>('input[aria-label="搜索"]')!;

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(element: Element, key: string) {
  await act(async () => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
  await flush();
}

beforeEach(() => {
  useWorkspaceStore.setState({ workspace: {} });
});

afterEach(async () => {
  await cleanup();
  setWire(undefined);
  onProject.mockClear();
});

describe("走目录", () => {
  it("opens at the machine's home, showing what is not hidden", async () => {
    const fake = machineHost();
    await open();
    expect(fake.calls.at(-1)).toMatchObject({
      target: "projects",
      action: "directories",
      args: { machineId: "m1" },
    });
    expect(crumbs()).toEqual(["/", "~"]);
    expect(rows()).toEqual(["Developer", "Documents"]);
  });

  it("opens where it was sent", async () => {
    machineHost();
    await open({ start: `${HOME}/Developer` });
    expect(crumbs()).toEqual(["/", "~", "Developer"]);
  });

  it("goes in on one click, and marks repositories and projects", async () => {
    machineHost();
    await open();
    await click(row("Developer"));
    await flush();
    expect(crumbs()).toEqual(["/", "~", "Developer"]);
    expect(rows()).toEqual(["billinggit", "etagit已添加", "notes"]);
    await click(row("notes"));
    await flush();
    expect(crumbs()).toEqual(["/", "~", "Developer", "notes"]);
    expect(document.body.textContent).toContain("这里没有子目录");
  });

  it("jumps back along the path", async () => {
    machineHost();
    await open({ start: `${HOME}/Developer/notes` });
    await click(crumb("~"));
    await flush();
    expect(crumbs()).toEqual(["/", "~"]);
    expect(rows()).toEqual(["Developer", "Documents"]);
  });

  it("counts from the root outside the home", async () => {
    machineHost();
    await open({ start: "/srv" });
    expect(crumbs()).toEqual(["/", "srv"]);
  });

  it("shows the Windows drive above the home and walks to its root", async () => {
    machineHost({ home: WINDOWS_HOME, directories: windowsTree });
    await open();
    expect(crumbs()).toEqual(["C:", "~"]);
    expect(rows()).toEqual(["Desktop", "Documents"]);

    await click(crumb("C:"));
    await flush();
    expect(crumbs()).toEqual(["C:"]);
    expect(rows()).toEqual(["Users", "Windows"]);

    await click(row("Users"));
    await flush();
    expect(crumbs()).toEqual(["C:", "Users"]);
    expect(rows()).toEqual(["me"]);
  });

  it("walks and shortens Windows project paths with backslashes", async () => {
    const project = projectView({
      id: "pw",
      name: "windows-app",
      path: "C:\\Users\\me\\Desktop\\eta",
    });
    machineHost({
      home: WINDOWS_HOME,
      directories: windowsTree,
      projects: [project],
    });
    await open();
    expect(rows()[0]).toBe("windows-app~/Desktop");

    await click(row("Desktop"));
    await flush();
    expect(crumbs()).toEqual(["C:", "~", "Desktop"]);
    expect(rows()).toEqual(["eta"]);
  });

  it("filters this list only, and forgets the filter on the way in", async () => {
    machineHost();
    await open();
    await type(filterBox(), "DOC");
    expect(rows()).toEqual(["Documents"]);
    await type(filterBox(), "zzz");
    expect(rows()).toEqual([]);
    expect(document.body.textContent).toContain("没有匹配的目录");
    await type(filterBox(), "dev");
    await click(row("Developer"));
    await flush();
    expect(filterBox().value).toBe("");
    expect(rows()).toHaveLength(3);
  });

  it("shows hidden directories when asked, and keeps showing them", async () => {
    machineHost();
    await open();
    expect(rows()).not.toContain(".config");
    await click(document.querySelector('[role="checkbox"]'));
    expect(rows()).toContain(".config");
    await click(row("Developer"));
    await flush();
    await click(crumb("~"));
    await flush();
    expect(rows()).toContain(".config");
  });

  it("says when the list was cut", async () => {
    const fake = machineHost();
    fake.handle("projects.directories", () => ({
      path: HOME,
      home: HOME,
      parent: "/home",
      entries: [entry("a"), entry("b")],
      truncated: true,
    }));
    await open();
    expect(document.body.textContent).toContain("只列出前 2 个");
  });
});

describe("输入路径", () => {
  const openBox = async () => {
    await click(button(document.body, "输入路径"));
    return pathBox()!;
  };

  it("takes the place of the path, filled in and focused", async () => {
    machineHost();
    await open({ start: `${HOME}/Developer` });
    const box = await openBox();
    expect(box.value).toBe(`${HOME}/Developer`);
    expect(document.activeElement).toBe(box);
    expect(document.querySelector("nav")).toBeNull();
  });

  it("goes there on Enter, `~` included", async () => {
    machineHost();
    await open();
    const box = await openBox();
    await type(box, " ~/Developer ");
    await press(box, "Enter");
    expect(pathBox()).toBeNull();
    expect(crumbs()).toEqual(["/", "~", "Developer"]);
    expect(rows()).toHaveLength(3);
  });

  it("takes a typed Windows path", async () => {
    machineHost({ home: WINDOWS_HOME, directories: windowsTree });
    await open();
    const box = await openBox();
    await type(box, "C:\\Users\\me\\Desktop");
    await press(box, "Enter");
    expect(crumbs()).toEqual(["C:", "~", "Desktop"]);
    expect(rows()).toEqual(["eta"]);
  });

  it("stays in the box with what was typed when the path does not work", async () => {
    machineHost({ failing: { "/root": "denied" } });
    await open();
    const box = await openBox();
    await type(box, "/nope");
    await press(box, "Enter");
    expect(pathBox()!.value).toBe("/nope");
    expect(document.querySelector('[role="alert"]')!.textContent).toBe(
      "这个目录不存在",
    );
    await type(pathBox()!, "/root");
    // Editing takes the complaint back: it was about the last path.
    expect(document.querySelector('[role="alert"]')).toBeNull();
    await press(pathBox()!, "Enter");
    expect(document.querySelector('[role="alert"]')!.textContent).toBe(
      "没有权限读取这个目录",
    );
    expect(rows()).toEqual(["Developer", "Documents"]);
  });

  it("goes back to the path on cancel, without going anywhere", async () => {
    machineHost();
    await open();
    const box = await openBox();
    await type(box, "/srv");
    await click(button(document.body, "取消"));
    expect(pathBox()).toBeNull();
    expect(crumbs()).toEqual(["/", "~"]);
  });
});

describe("读不了的时候", () => {
  it("offers the way up from a directory it may not read", async () => {
    machineHost({ failing: { [`${HOME}/Developer/notes`]: "denied" } });
    await open({ start: `${HOME}/Developer/notes` });
    expect(document.querySelector('[role="alert"]')!.textContent).toContain(
      "没有权限读取这个目录",
    );
    await click(button(document.body, "回到上一级"));
    await flush();
    expect(crumbs()).toEqual(["/", "~", "Developer"]);
  });

  it("says so when a directory is gone", async () => {
    machineHost();
    await open({ start: `${HOME}/gone` });
    expect(document.querySelector('[role="alert"]')!.textContent).toContain(
      "这个目录不存在",
    );
  });

  it("offers a retry when the machine does not answer", async () => {
    const failing: Record<string, string> = { [HOME]: "offline" };
    machineHost({ failing });
    await open();
    expect(document.querySelector('[role="alert"]')!.textContent).toContain(
      "连不上这台机器",
    );
    delete failing[HOME];
    await click(button(document.body, "重试"));
    await flush();
    expect(rows()).toEqual(["Developer", "Documents"]);
  });

  it("treats a failure with no reason as the machine not answering", async () => {
    const fake = machineHost();
    fake.handle("projects.directories", () => {
      throw new Error("boom");
    });
    await open();
    expect(document.body.textContent).toContain("连不上这台机器");
    expect(document.body.textContent).not.toContain("boom");
  });
});

describe("几台机器", () => {
  const remote = machineView({ id: "m2", name: "gpu", kind: "daemon" });
  const away = machineView({
    id: "m3",
    name: "笔记本",
    kind: "daemon",
    status: "offline",
  });

  const chip = (name: string) =>
    [
      ...document.querySelectorAll<HTMLButtonElement>('[role="group"] button'),
    ].find((candidate) => candidate.textContent === name);

  it("shows no switch with one usable machine", async () => {
    machineHost({ machines: [primary, away] });
    await open();
    expect(document.querySelector('[role="group"]')).toBeNull();
  });

  it("opens on the machine it was sent to, and offline ones cannot be chosen", async () => {
    const fake = machineHost({ machines: [primary, remote, away] });
    await open({ machineId: "m2" });
    expect(chip("gpu")!.getAttribute("aria-pressed")).toBe("true");
    expect(chip("笔记本")!.disabled).toBe(true);
    expect(fake.calls.at(-1)!.args).toEqual({ machineId: "m2" });
  });

  it("goes to the other machine's home on a switch", async () => {
    const fake = machineHost({ machines: [primary, remote] });
    await open({ start: `${HOME}/Developer` });
    await click(chip("gpu"));
    await flush();
    expect(fake.calls.at(-1)!.args).toEqual({ machineId: "m2" });
    expect(crumbs()).toEqual(["/", "~"]);
  });
});

describe("主目录顶上的项目", () => {
  const eta = projectView({
    id: "p1",
    name: "eta",
    path: `${HOME}/Developer/eta`,
  });
  const house = projectView({
    id: "p2",
    name: "house",
    path: `${HOME}/work/house`,
  });
  const remember = (paths: string[], machineId = "m1") =>
    useWorkspaceStore.setState({
      workspace: { recentDirectories: { [machineId]: paths } },
    });

  it("are at the top of the home and nowhere else", async () => {
    machineHost({ projects: [eta, house] });
    await open();
    expect(rows()).toEqual([
      "eta~/Developer",
      "house~/work",
      "Developer",
      "Documents",
    ]);
    expect(document.body.textContent).toContain("主目录");
    await click(row("Developer"));
    await flush();
    expect(rows()).not.toContain("eta~/Developer");
    expect(document.body.textContent).not.toContain("主目录");
  });

  it("put what was used first, and the rest after in their own order", async () => {
    const third = projectView({ id: "p3", name: "zed", path: "/srv/zed" });
    machineHost({ projects: [eta, third, house] });
    remember([`${HOME}/work/house`, `${HOME}/gone`]);
    await open();
    expect(rows().slice(0, 3)).toEqual([
      "house~/work",
      "eta~/Developer",
      "zed/srv",
    ]);
  });

  it("are taken on a click, rather than walked into", async () => {
    const fake = machineHost({ projects: [eta] });
    await open();
    const asked = fake.calls.length;
    await click(row("eta"));
    await flush();
    expect(onProject).toHaveBeenCalledWith(eta);
    expect(fake.calls).toHaveLength(asked);
  });

  it("are found by the search too", async () => {
    machineHost({ projects: [eta, house] });
    await open();
    await type(filterBox(), "hou");
    expect(rows()).toEqual(["house~/work"]);
    await type(filterBox(), "doc");
    expect(rows()).toEqual(["Documents"]);
    expect(document.body.textContent).not.toContain("主目录");
  });

  it("leave out what is put away, an agent's own, and other machines'", async () => {
    machineHost({
      machines: [
        primary,
        machineView({ id: "m2", name: "gpu", kind: "daemon" }),
      ],
      projects: [
        eta,
        projectView({ id: "p3", name: "old", path: "/old", archived: true }),
        projectView({
          id: "p4",
          name: "own",
          path: "/own",
          kind: "agent_home",
        }),
        projectView({ id: "p5", name: "far", path: "/far", machineId: "m2" }),
      ],
    });
    await open();
    expect(rows().slice(0, -2)).toEqual(["eta~/Developer"]);
  });

  it("change with the machine", async () => {
    const fake = machineHost({
      machines: [
        primary,
        machineView({ id: "m2", name: "gpu", kind: "daemon" }),
      ],
      projects: [
        eta,
        projectView({ id: "p5", name: "far", path: "/far", machineId: "m2" }),
      ],
    });
    await open();
    await click(
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[role="group"] button',
        ),
      ].find((candidate) => candidate.textContent === "gpu"),
    );
    await flush();
    expect(fake.calls.at(-1)!.args).toEqual({ machineId: "m2" });
    expect(rows()[0]).toBe("far/");
  });
});
