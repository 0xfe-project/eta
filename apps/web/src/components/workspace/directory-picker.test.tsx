import type { DirectoryEntry, ProjectResults } from "@eta/client-contracts";
import type { DirectoryPickerProps } from "./directory-picker";
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
  conversationView,
  machineView,
  productHost,
  projectView,
} from "@/test-product";
import { button, cleanup, click, flush, mount } from "@/test-render";
import { DirectoryPicker } from "./directory-picker";
import { NewConversationDialog } from "./new-conversation-dialog";
import { useWorkspaceStore } from "./workspace-store";

rstest.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => {},
}));

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
} = {}) {
  const fake = productHost({
    machines,
    projects,
    agents: [agentView({ id: "a1", name: "乐子人" })],
  });
  fake.handle("projects.directories", (raw) => {
    const { path = HOME } = raw as { path?: string };
    const asked = path.startsWith("~") ? `${HOME}${path.slice(1)}` : path;
    const code = failing[asked];
    if (code !== undefined) throw new Problem(code);
    const entries = tree[asked];
    if (entries === undefined) throw new Problem("not_found");
    const result: ProjectResults["directories"] = {
      path: asked,
      home: HOME,
      parent: asked.slice(0, asked.lastIndexOf("/")) || "/",
      entries,
      truncated: false,
    };
    return result;
  });
  return fake;
}

const onPick = rstest.fn();
const onBack = rstest.fn();

async function open(fields: Partial<DirectoryPickerProps> = {}) {
  const view = await mount(
    <Dialog open>
      <DialogContent>
        <DirectoryPicker
          machineId="m1"
          start={undefined}
          onPick={onPick}
          onBack={onBack}
          {...fields}
        />
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
const chooser = () => button(document.body, "选择此目录")!;
const pathBox = () =>
  document.querySelector<HTMLInputElement>('input[aria-label="目录路径"]');
const filterBox = () =>
  document.querySelector<HTMLInputElement>('input[aria-label="筛选"]')!;

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
  onPick.mockClear();
  onBack.mockClear();
  useWorkspaceStore.setState({ newConversation: { open: false } });
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
    expect(crumbs()).toEqual(["~"]);
    expect(rows()).toEqual(["Developer", "Documents"]);
  });

  it("opens where the field already points", async () => {
    machineHost();
    await open({ start: `${HOME}/Developer` });
    expect(crumbs()).toEqual(["~", "Developer"]);
  });

  it("goes in on one click, and marks repositories and projects", async () => {
    machineHost();
    await open();
    await click(row("Developer"));
    await flush();
    expect(crumbs()).toEqual(["~", "Developer"]);
    expect(rows()).toEqual(["billinggit", "etagit已添加", "notes"]);
    await click(row("notes"));
    await flush();
    expect(crumbs()).toEqual(["~", "Developer", "notes"]);
    expect(document.body.textContent).toContain("这里没有子目录");
    expect(chooser().disabled).toBe(false);
  });

  it("jumps back along the path", async () => {
    machineHost();
    await open({ start: `${HOME}/Developer/notes` });
    await click(crumb("~"));
    await flush();
    expect(crumbs()).toEqual(["~"]);
    expect(rows()).toEqual(["Developer", "Documents"]);
  });

  it("counts from the root outside the home", async () => {
    machineHost();
    await open({ start: "/srv" });
    expect(crumbs()).toEqual(["/", "srv"]);
  });

  it("chooses where it is, not a row", async () => {
    machineHost();
    await open();
    await click(row("Developer"));
    await flush();
    await click(chooser());
    expect(onPick).toHaveBeenCalledWith(`${HOME}/Developer`, "m1");
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
    expect(crumbs()).toEqual(["~", "Developer"]);
    expect(rows()).toHaveLength(3);
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

  it("does not choose while the box is open, because it would not be what the box says", async () => {
    machineHost();
    await open();
    await openBox();
    expect(chooser().disabled).toBe(true);
  });

  it("goes back to the path on cancel, without going anywhere", async () => {
    machineHost();
    await open();
    const box = await openBox();
    await type(box, "/srv");
    await click(button(document.body, "取消"));
    expect(pathBox()).toBeNull();
    expect(crumbs()).toEqual(["~"]);
    expect(onBack).not.toHaveBeenCalled();
  });

  it("takes one step back on Escape", async () => {
    machineHost();
    await open();
    await press(await openBox(), "Escape");
    expect(pathBox()).toBeNull();
    expect(onBack).not.toHaveBeenCalled();
  });
});

describe("读不了的时候", () => {
  it("offers the way up from a directory it may not read, and nothing to choose", async () => {
    machineHost({ failing: { [`${HOME}/Developer/notes`]: "denied" } });
    await open({ start: `${HOME}/Developer/notes` });
    expect(document.querySelector('[role="alert"]')!.textContent).toContain(
      "没有权限读取这个目录",
    );
    expect(chooser().disabled).toBe(true);
    await click(button(document.body, "回到上一级"));
    await flush();
    expect(crumbs()).toEqual(["~", "Developer"]);
    expect(chooser().disabled).toBe(false);
  });

  it("says so when a directory is gone", async () => {
    machineHost();
    await open({ start: `${HOME}/gone` });
    expect(document.querySelector('[role="alert"]')!.textContent).toContain(
      "这个目录不存在",
    );
    expect(chooser().disabled).toBe(true);
  });

  it("offers a retry when the machine does not answer", async () => {
    const failing: Record<string, string> = { [HOME]: "offline" };
    machineHost({ failing });
    await open();
    expect(document.querySelector('[role="alert"]')!.textContent).toContain(
      "连不上这台机器",
    );
    expect(chooser().disabled).toBe(true);
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
    expect(crumbs()).toEqual(["~"]);
    await click(chooser());
    expect(onPick).toHaveBeenCalledWith(HOME, "m2");
  });
});

describe("最近用过", () => {
  const remember = (paths: string[], machineId = "m1") =>
    useWorkspaceStore.setState({
      workspace: { recentDirectories: { [machineId]: paths } },
    });

  it("is at the top of the home and nowhere else", async () => {
    machineHost();
    remember([`${HOME}/Developer/billing`, `${HOME}/old`]);
    await open();
    expect(document.body.textContent).toContain("最近用过");
    expect(rows()).toEqual([
      "billing~/Developer",
      "old~",
      "Developer",
      "Documents",
    ]);
    await type(filterBox(), "dev");
    expect(document.body.textContent).not.toContain("最近用过");
    await type(filterBox(), "");
    await click(row("Developer"));
    await flush();
    expect(document.body.textContent).not.toContain("最近用过");
  });

  it("is not there for a machine with nothing to remember", async () => {
    machineHost();
    remember(["/srv"], "m2");
    await open();
    expect(document.body.textContent).not.toContain("最近用过");
  });

  it("walks into a remembered directory, and a stale one says it is gone", async () => {
    machineHost();
    remember([`${HOME}/Developer/billing`, `${HOME}/Developer`]);
    await open();
    await click(row("billing"));
    await flush();
    expect(document.querySelector('[role="alert"]')!.textContent).toContain(
      "这个目录不存在",
    );
    await click(button(document.body, "回到上一级"));
    await flush();
    expect(crumbs()).toEqual(["~", "Developer"]);
  });
});

describe("从新对话进去再回来", () => {
  async function startDialog(
    options: Parameters<typeof machineHost>[0] = {},
    projectId?: string,
  ) {
    const fake = machineHost({
      projects: [projectView({ id: "p1", name: "eta", path: "/work/eta" })],
      ...options,
    });
    fake.handle("projects.create", (args) => ({
      project: projectView({
        id: "made",
        path: (args as { path: string }).path,
      }),
      existed: false,
    }));
    fake.handle("conversations.create", () => ({
      conversation: conversationView({ id: "c-new" }),
    }));
    useWorkspaceStore.setState({ newConversation: { open: true, projectId } });
    await mount(<NewConversationDialog />);
    await flush();
    return fake;
  }

  const addDirectory = async (label = "添加目录…") => {
    await act(async () => {
      document
        .querySelector("#new-project")!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
        );
    });
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((candidate) => candidate.textContent === label);
    await act(async () => option!.click());
    await flush();
  };

  const onForm = () => document.body.textContent!.includes("乐子人");
  const field = () => document.querySelector("#new-project")!;
  const panel = () => document.querySelector('[data-slot="dialog-content"]')!;

  it("swaps the form for the view, wider, in one dialog", async () => {
    await startDialog();
    expect(panel().className).toContain("sm:max-w-md");
    await addDirectory();
    expect(onForm()).toBe(false);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(panel().className).toContain("sm:max-w-[560px]");
    await click(button(document.body, "取消"));
    expect(onForm()).toBe(true);
    expect(panel().className).toContain("sm:max-w-md");
  });

  it("back and cancel return to the form as it was left", async () => {
    await startDialog(undefined, "p1");
    await addDirectory();
    await click(document.querySelector('button[aria-label="返回"]'));
    expect(onForm()).toBe(true);
    expect(field().textContent).toContain("eta");
    expect(document.activeElement).toBe(field());
  });

  it("Escape in the view returns to the form, and the dialog stays open", async () => {
    await startDialog();
    await addDirectory();
    await press(filterBox(), "Escape");
    expect(onForm()).toBe(true);
    expect(useWorkspaceStore.getState().newConversation.open).toBe(true);
  });

  it("Escape on the form still closes it", async () => {
    await startDialog();
    await press(document.activeElement ?? document.body, "Escape");
    expect(useWorkspaceStore.getState().newConversation.open).toBe(false);
  });

  it("shows the chosen directory in the field, adds it, and remembers it", async () => {
    const fake = await startDialog();
    await addDirectory();
    await click(row("Developer"));
    await flush();
    await click(chooser());
    await flush();
    expect(onForm()).toBe(true);
    expect(field().textContent).toContain(`Developer${HOME}/Developer`);
    expect(
      useWorkspaceStore.getState().workspace.recentDirectories?.m1,
    ).toEqual([`${HOME}/Developer`]);
    await click(button(document.body, "开始"));
    await flush();
    expect(fake.calls.find((call) => call.action === "create")).toMatchObject({
      target: "projects",
      args: { path: `${HOME}/Developer`, machineId: "m1", stewardId: "a1" },
    });
  });

  it("reopens where the last choice was", async () => {
    await startDialog();
    await addDirectory();
    await click(row("Developer"));
    await flush();
    await click(chooser());
    await flush();
    await addDirectory();
    expect(crumbs()).toEqual(["~", "Developer"]);
  });

  it("uses the project a chosen directory already is, without adding it", async () => {
    const fake = await startDialog({
      projects: [
        projectView({ id: "p1", name: "eta", path: "/work/eta" }),
        projectView({ id: "p2", name: "dev", path: `${HOME}/Developer` }),
      ],
    });
    await addDirectory();
    await click(row("Developer"));
    await flush();
    await click(chooser());
    await flush();
    expect(field().textContent).toContain("dev");
    await click(button(document.body, "开始"));
    await flush();
    expect(
      fake.calls.find(
        (call) => call.target === "projects" && call.action === "create",
      ),
    ).toBeUndefined();
    expect(fake.calls.at(-1)).toMatchObject({
      target: "conversations",
      action: "create",
      args: { projectId: "p2" },
    });
  });

  it("leaves a put-away project to the host, which brings it back", async () => {
    const fake = await startDialog({
      projects: [
        projectView({ id: "p1", name: "eta", path: "/work/eta" }),
        projectView({
          id: "p2",
          name: "dev",
          path: `${HOME}/Developer`,
          archived: true,
        }),
      ],
    });
    await addDirectory();
    await click(row("Developer"));
    await flush();
    await click(chooser());
    await flush();
    await click(button(document.body, "开始"));
    await flush();
    expect(
      fake.calls.find(
        (call) => call.target === "projects" && call.action === "create",
      ),
    ).toMatchObject({ args: { path: `${HOME}/Developer` } });
  });

  it("opens on the machine the option named", async () => {
    const fake = await startDialog({
      machines: [
        primary,
        machineView({ id: "m2", name: "gpu", kind: "daemon" }),
      ],
    });
    await addDirectory("在 gpu 上添加目录…");
    expect(fake.calls.at(-1)!.args).toEqual({ machineId: "m2" });
    await click(chooser());
    await flush();
    await click(button(document.body, "开始"));
    await flush();
    expect(fake.calls.find((call) => call.action === "create")).toMatchObject({
      target: "projects",
      args: { machineId: "m2" },
    });
  });
});
