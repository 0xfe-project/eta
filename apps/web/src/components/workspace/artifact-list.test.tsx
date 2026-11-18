import type { ArtifactView } from "@eta/client-contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { NuqsAdapter } from "nuqs/adapters/tanstack-router";
import { act, useState } from "react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { setWire } from "@/lib/wire";
import { surfaceHost } from "@/test-inbox";
import {
  agentView,
  artifactView,
  conversationView,
  taskDetail,
} from "@/test-product";
import { cleanup, flush, mount as render } from "@/test-render";
import { resetArtifactFilters } from "./artifact-filter";
import { GroupArtifacts } from "./artifact-list";

const HOUR = 3_600_000;
const now = Date.now();
const startOfToday = new Date(new Date(now).setHours(0, 0, 0, 0)).getTime();
// Today, but never in the future: just after midnight "an hour ago" would be yesterday.
const today = (minutes: number) =>
  Math.max(startOfToday, now - minutes * 60_000);
const yesterday = (hours: number) => startOfToday - hours * HOUR;
const daysAgo = (days: number) => startOfToday - days * 24 * HOUR;

const versions = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    ...artifactView({ id: "x" }).versions[0]!,
    number: count - i,
  }));

const artifact = (
  id: string,
  title: string,
  fields: Partial<ArtifactView> = {},
) =>
  artifactView({
    id,
    title,
    conversationId: "g1",
    publisherAgentId: "opus",
    ...fields,
  });

const agents = [
  agentView({ id: "opus", name: "Opus" }),
  agentView({ id: "reviewer", name: "Reviewer" }),
];

/** Seven, of two publishers, over three days, one tied to task #122, two revised. */
const seven = [
  artifact("a1", "Routine row redesign", {
    updatedAt: today(5),
    createdAt: daysAgo(4),
  }),
  artifact("a2", "#554 Subtasks · Guided review", {
    publisherAgentId: "reviewer",
    taskId: "t122",
    versions: versions(2),
    updatedAt: today(30),
    createdAt: today(40),
  }),
  artifact("a3", "README plan", {
    versions: versions(3),
    updatedAt: yesterday(2),
    createdAt: daysAgo(6),
  }),
  artifact("a4", "guided review: agent homes", {
    publisherAgentId: "reviewer",
    updatedAt: yesterday(5),
    createdAt: yesterday(5),
  }),
  artifact("a5", "Captain choice box", {
    updatedAt: daysAgo(3),
    createdAt: daysAgo(3),
  }),
  artifact("a6", "Agent wizard", {
    updatedAt: daysAgo(5),
    createdAt: daysAgo(2),
  }),
  artifact("a7", "Board layout", {
    updatedAt: daysAgo(7),
    createdAt: daysAgo(7),
  }),
];

/** Opens another group in the last panel mounted. */
let openGroup = async (_group: string) => {};
let showTab: (shown: boolean) => void;

function Tab() {
  // Another tab is this one unmounted: the panel draws only the open tab.
  const [shown, setShown] = useState(true);
  showTab = setShown;
  return shown ? <GroupArtifacts /> : null;
}

async function mount(artifacts: ArtifactView[], path = "/?group=g1") {
  surfaceHost({
    agents,
    conversations: [
      conversationView({ id: "g1", name: "eta" }),
      conversationView({ id: "g2", name: "其他" }),
    ],
    tasks: [
      {
        task: taskDetail({
          id: "t122",
          number: 122,
          title: "子任务",
          conversationId: "g1",
        }),
      },
    ],
    artifacts,
  });
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <NuqsAdapter>
          <div id="workspace-panel">
            <Tab />
          </div>
        </NuqsAdapter>
      ),
    }),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const { container } = await render(<RouterProvider router={router} />);
  await act(async () => router.load());
  await flush();
  openGroup = async (group) => {
    await act(async () =>
      router.navigate({ to: "/", search: { group } as never }),
    );
    await flush();
  };
  return container;
}

beforeEach(() => resetArtifactFilters());
afterEach(async () => {
  await cleanup();
  setWire(undefined);
});

const titles = (root: ParentNode) =>
  [...root.querySelectorAll("li button[aria-label]")].map(
    (b) => b.getAttribute("title") ?? "",
  );
const headings = (root: ParentNode) =>
  [...root.querySelectorAll("section > h3")].map((h) => h.textContent);
const searchBox = (root: ParentNode) =>
  root.querySelector<HTMLInputElement>('input[type="search"]')!;
const chips = (root: ParentNode) =>
  [...root.querySelectorAll("button[aria-pressed]")].map((b) => b.textContent);
const buttonNamed = (root: ParentNode, text: string) =>
  [...root.querySelectorAll("button")].find(
    (b) =>
      b.textContent?.trim() === text || b.getAttribute("aria-label") === text,
  );
const range = (root: ParentNode) =>
  root.querySelector("[data-range]")?.textContent;
const found = (root: ParentNode) =>
  root.querySelector("[data-found]")?.textContent;

async function type(root: ParentNode, value: string) {
  const input = searchBox(root);
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(target: Element, key: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

async function clickOn(element: Element | undefined) {
  if (!element) throw new Error("nothing to click");
  await act(async () => (element as HTMLElement).click());
  await flush();
}

/** Radix opens a menu on pointer down; its items are then in the document. */
async function menuItem(root: ParentNode, label: string) {
  const trigger =
    buttonNamed(root, "排序最近更新") ??
    [...root.querySelectorAll("button")].find((b) =>
      b.textContent?.startsWith("排序"),
    );
  // A checkbox leaves the menu open, so the next one is picked from it as it is.
  if (!document.querySelector('[role="menu"]'))
    await act(async () => {
      trigger!.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const item = [
    ...document.querySelectorAll<HTMLElement>(
      '[role="menuitemradio"], [role="menuitemcheckbox"]',
    ),
  ].find((candidate) => candidate.textContent.includes(label));
  expect(item, label).toBeDefined();
  return item!;
}

it("searches titles as you type, whatever the case or width, and marks what matched", async () => {
  const container = await mount(seven);
  await type(container, "GUIDED");
  expect(titles(container)).toEqual([
    "#554 Subtasks · Guided review",
    "guided review: agent homes",
  ]);
  expect(
    [...container.querySelectorAll("mark")].map((m) => m.textContent),
  ).toEqual(["Guided", "guided"]);
  // Full-width letters and digits are the same letters.
  await type(container, "ｇｕｉｄｅｄ");
  expect(titles(container)).toHaveLength(2);
  await type(container, "＃５５４");
  expect(titles(container)).toEqual(["#554 Subtasks · Guided review"]);
  expect(container.querySelector("mark")!.textContent).toBe("#554");
  // Esc in the box empties it.
  await press(searchBox(container), "Escape");
  expect(searchBox(container).value).toBe("");
  expect(titles(container)).toHaveLength(7);
});

it("`/` in the panel goes to the search box", async () => {
  const container = await mount(seven);
  await press(container.querySelector("li button")!, "/");
  expect(document.activeElement).toBe(searchBox(container));
});

it("counts each publisher's chip by what the search leaves", async () => {
  const container = await mount(seven);
  expect(chips(container)).toEqual(["全部7", "Opus5", "Reviewer2"]);
  await type(container, "guided");
  expect(chips(container)).toEqual(["全部2", "Opus0", "Reviewer2"]);
  await clickOn(
    [...container.querySelectorAll("button[aria-pressed]")].find((b) =>
      b.textContent?.startsWith("Reviewer"),
    ),
  );
  expect(titles(container)).toHaveLength(2);
  expect(found(container)).toBe("7 个里找到 2 个");
  await type(container, "agent");
  expect(titles(container)).toEqual(["guided review: agent homes"]);
  expect(chips(container)).toEqual(["全部2", "Opus1", "Reviewer1"]);
});

it("shows no publisher row when only one agent has published", async () => {
  const container = await mount(
    seven.map((a) => ({ ...a, publisherAgentId: "opus" })),
  );
  expect(chips(container)).toEqual([]);
  // The sort menu is still there.
  expect(container.textContent).toContain("排序");
});

it("sorts three ways, and groups by day only when the order is by time", async () => {
  const container = await mount(seven);
  // Recently updated, by default.
  expect(titles(container)).toEqual([
    "Routine row redesign",
    "#554 Subtasks · Guided review",
    "README plan",
    "guided review: agent homes",
    "Captain choice box",
    "Agent wizard",
    "Board layout",
  ]);
  expect(headings(container)).toEqual(["今天", "昨天", "更早"]);

  await clickOn(await menuItem(container, "最近创建"));
  expect(titles(container)).toEqual([
    "#554 Subtasks · Guided review",
    "guided review: agent homes",
    "Agent wizard",
    "Captain choice box",
    "Routine row redesign",
    "README plan",
    "Board layout",
  ]);
  expect(headings(container)).toEqual(["今天", "昨天", "更早"]);

  await clickOn(await menuItem(container, "标题"));
  expect(titles(container)).toEqual([
    "#554 Subtasks · Guided review",
    "Agent wizard",
    "Board layout",
    "Captain choice box",
    "guided review: agent homes",
    "README plan",
    "Routine row redesign",
  ]);
  expect(headings(container)).toEqual([]);
});

it("narrows to those tied to a task or revised, both at once, and clears", async () => {
  const container = await mount(seven);
  expect(found(container)).toBeUndefined();
  await clickOn(await menuItem(container, "关联了任务的"));
  expect(titles(container)).toEqual(["#554 Subtasks · Guided review"]);
  expect(found(container)).toBe("7 个里找到 1 个");
  await clickOn(await menuItem(container, "改过不止一版的"));
  expect(titles(container)).toEqual(["#554 Subtasks · Guided review"]);
  await clickOn(await menuItem(container, "关联了任务的"));
  expect(titles(container)).toEqual([
    "#554 Subtasks · Guided review",
    "README plan",
  ]);
  await clickOn(buttonNamed(container, "清除筛选"));
  expect(titles(container)).toHaveLength(7);
  expect(found(container)).toBeUndefined();
});

it("says so when nothing matches, and clears from there", async () => {
  const container = await mount(seven);
  await type(container, "nothing like it");
  expect(titles(container)).toEqual([]);
  expect(container.textContent).toContain(
    "没有找到匹配『nothing like it』的产物",
  );
  await clickOn(buttonNamed(container, "清除筛选"));
  expect(titles(container)).toHaveLength(7);
});

it("tags a row tied to a task with its number, a link to the task", async () => {
  const container = await mount(seven);
  const tag = container.querySelector('a[aria-label="打开任务 #122"]')!;
  expect(tag.textContent).toBe("#122");
  expect(tag.getAttribute("href")).toContain("task=t122");
  // The rest of the row is the artifact's button, as before.
  const row = tag.closest("li")!;
  expect(row.querySelector("button")!.getAttribute("aria-label")).toContain(
    "#554 Subtasks · Guided review",
  );
  expect(row.textContent).toContain("Reviewer");
  expect(row.textContent).toContain("v2");
});

const many = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    artifact(`m${i}`, `Artifact ${String(i).padStart(2, "0")}`, {
      updatedAt: today(i),
      publisherAgentId: i % 2 ? "reviewer" : "opus",
    }),
  );

it("pages by 15, and starts again from the first page when the filters change", async () => {
  const container = await mount(many(47));
  expect(titles(container)).toHaveLength(15);
  expect(range(container)).toBe("1–15 / 47");
  expect(buttonNamed(container, "第 4 页")).toBeDefined();
  await clickOn(buttonNamed(container, "下一页"));
  expect(range(container)).toBe("16–30 / 47");
  expect(titles(container)[0]).toBe("Artifact 15");
  // Each page heads its own run of days.
  expect(headings(container)).toEqual(["今天"]);
  await clickOn(buttonNamed(container, "第 4 页"));
  expect(range(container)).toBe("46–47 / 47");
  expect(buttonNamed(container, "下一页")!.disabled).toBe(true);
  await type(container, "Artifact 1");
  expect(range(container)).toBe("1–10 / 10");
  // One page: the count, no page buttons.
  expect(buttonNamed(container, "第 1 页")).toBeUndefined();
  expect(buttonNamed(container, "下一页")).toBeUndefined();
});

it("puts a gap in a long row of pages", async () => {
  const container = await mount(many(150));
  const pages = () =>
    [...container.querySelectorAll("nav")].at(-1)!.textContent;
  expect(pages()).toBe("1–15 / 15012…910");
  await clickOn(buttonNamed(container, "第 2 页"));
  await clickOn(buttonNamed(container, "第 3 页"));
  await clickOn(buttonNamed(container, "第 4 页"));
  expect(pages()).toBe("46–60 / 15012345…910");
});

it("keeps the filters and the page across tabs, and drops them for another group", async () => {
  const container = await mount(many(47));
  await clickOn(buttonNamed(container, "第 2 页"));
  await clickOn(
    [...container.querySelectorAll("button[aria-pressed]")].find((b) =>
      b.textContent?.startsWith("Opus"),
    ),
  );
  await clickOn(buttonNamed(container, "第 2 页"));
  expect(range(container)).toBe("16–24 / 24");
  await act(async () => showTab(false));
  await act(async () => showTab(true));
  await flush();
  expect(range(container)).toBe("16–24 / 24");
  expect(found(container)).toBe("47 个里找到 24 个");

  // Another group starts clean; coming back does not bring the first one's back either.
  await openGroup("g2");
  await openGroup("g1");
  expect(range(container)).toBe("1–15 / 47");
  expect(found(container)).toBeUndefined();
});
