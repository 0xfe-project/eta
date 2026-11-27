import { expect, open, test } from "nsh/test";
import { border, control, icon, sizes, space } from "../src/components/tokens";

const fixture = "./fixtures/sidebar-alignment.tsx";

const rightEdge = (box: { x: number; width: number }) => box.x + box.width;

test("desktop sidebar aligns every trailing control and compact section nav icon onto the 16px guides", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 900,
    locale: "en-US",
  });
  await app.waitFor("text:ETA");
  await app.waitFor("text:Design review");

  const sidebar = app.layout("id:desktop-sidebar")!;
  expect(sidebar).not.toBeNull();
  expect(sidebar.width).toBe(sizes.sidebar);

  const innerRight = sidebar.x + sidebar.width - border.hair;
  const rightGuide = innerRight - space[16];
  const leftGuide = sidebar.x + space[16];

  const collapseIcon = app.layout("id:sidebar-collapse-icon")!;
  const captainStatus = app.layout("text:Idle")!;
  const tasksBadge = app.layout("label:Tasks >> text:1")!;
  const newGroupIcon = app.layout("id:sidebar-new-group-icon")!;
  const groupTimeNow = app.layout("text:now")!;
  const groupTimeMinutes = app.layout("text:29m")!;

  const trailingBoxes = [
    collapseIcon,
    captainStatus,
    tasksBadge,
    newGroupIcon,
    groupTimeNow,
    groupTimeMinutes,
  ];
  for (const box of trailingBoxes) {
    expect(box).not.toBeNull();
    expect(Math.abs(rightEdge(box) - rightGuide)).toBeLessThanOrEqual(1);
  }
  expect(collapseIcon.width).toBe(icon.md);
  expect(newGroupIcon.width).toBe(icon.sm);

  const rightEdges = trailingBoxes.map(rightEdge);
  expect(Math.max(...rightEdges) - Math.min(...rightEdges)).toBeLessThanOrEqual(
    1,
  );

  // Full hit targets stay intact and clear of the sidebar border / PaneHandle grip.
  const collapseButton = app.layout("label:Collapse sidebar")!;
  const newGroupButton = app.layout("label:New group")!;
  expect(collapseButton.width).toBe(control.md);
  expect(collapseButton.height).toBe(control.md);
  expect(newGroupButton.width).toBe(control.sm);
  expect(newGroupButton.height).toBe(control.sm);
  expect(innerRight - rightEdge(collapseButton)).toBeGreaterThanOrEqual(8);
  expect(innerRight - rightEdge(newGroupButton)).toBeGreaterThanOrEqual(8);

  // Left edge alignment across wordmark, compact section nav icons, Groups heading, project name, and Settings.
  const wordmark = app.layout("text:ETA")!;
  const chatIcon = app.layout("id:sidebar-nav-icon-chat")!;
  const tasksIcon = app.layout("id:sidebar-nav-icon-tasks")!;
  const routinesIcon = app.layout("id:sidebar-nav-icon-routines")!;
  const pluginsIcon = app.layout("id:sidebar-nav-icon-plugins")!;
  const groupsCaption = app.layout("text:Groups") ?? app.layout("text:GROUPS")!;
  const projectLabel = app.layout("text:eta >> nth=0")!;
  const settingsIcon = app.layout("id:sidebar-nav-icon-settings")!;

  for (const box of [
    wordmark,
    chatIcon,
    tasksIcon,
    routinesIcon,
    pluginsIcon,
    groupsCaption,
    projectLabel,
    settingsIcon,
  ]) {
    expect(box).not.toBeNull();
    expect(Math.abs(box.x - leftGuide)).toBeLessThanOrEqual(1);
  }

  // Collapsed mode keeps the expand button centered inside the 64px rail.
  await app.press("label:Collapse sidebar");
  await app.waitFor("label:Expand sidebar");
  const collapsedSidebar = app.layout("id:desktop-sidebar")!;
  const expandButton = app.layout("label:Expand sidebar")!;
  expect(collapsedSidebar.width).toBe(sizes.rail);
  const railCenter =
    collapsedSidebar.x + (collapsedSidebar.width - border.hair) / 2;
  const expandCenter = expandButton.x + expandButton.width / 2;
  expect(Math.abs(expandCenter - railCenter)).toBeLessThanOrEqual(1);

  // Expanding again restores the aligned right column.
  await app.press("label:Expand sidebar");
  await app.waitFor("id:sidebar-collapse-icon");
  expect(
    Math.abs(rightEdge(app.layout("id:sidebar-collapse-icon")!) - rightGuide),
  ).toBeLessThanOrEqual(1);
});

test("desktop sidebar keeps trailing controls aligned in zh-CN locale", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 900,
    locale: "zh-CN",
  });
  await app.waitFor("text:ETA");
  await app.waitFor("text:Design review");

  const sidebar = app.layout("id:desktop-sidebar")!;
  const rightGuide = sidebar.x + sidebar.width - border.hair - space[16];
  const leftGuide = sidebar.x + space[16];

  const trailingBoxes = [
    app.layout("id:sidebar-collapse-icon")!,
    app.layout("text:空闲")!,
    app.layout("label:任务 >> text:1")!,
    app.layout("id:sidebar-new-group-icon")!,
    app.layout("text:刚刚")!,
    app.layout("text:29 分钟")!,
  ];

  for (const box of trailingBoxes) {
    expect(box).not.toBeNull();
    expect(Math.abs(rightEdge(box) - rightGuide)).toBeLessThanOrEqual(1);
  }

  for (const box of [
    app.layout("text:ETA")!,
    app.layout("id:sidebar-nav-icon-chat")!,
    app.layout("id:sidebar-nav-icon-tasks")!,
    app.layout("text:群组")!,
    app.layout("id:sidebar-nav-icon-settings")!,
  ]) {
    expect(box).not.toBeNull();
    expect(Math.abs(box.x - leftGuide)).toBeLessThanOrEqual(1);
  }
});
