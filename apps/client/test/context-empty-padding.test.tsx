import type { App } from "nsh/test";
import { expect, open, test } from "nsh/test";
import { border, sizes, space } from "../src/components/tokens";

const fixture = "./fixtures/context-empty-padding.tsx";

function expectSymmetricEmptyRow(
  app: App,
  sectionId: string,
  contentSelector: string,
) {
  const section = app.layout(`id:${sectionId}`)!;
  const content = app.layout(`id:${sectionId} >> ${contentSelector}`)!;

  expect(section).toBeTruthy();
  expect(content).toBeTruthy();

  const emptyTop = section.y + sizes.sectionHeader;
  const emptyBottom = section.y + section.height - border.hair;
  const topGap = content.y - emptyTop;
  const bottomGap = emptyBottom - (content.y + content.height);

  expect(topGap).toBeGreaterThanOrEqual(space[8] - 1);
  expect(Math.abs(topGap - bottomGap)).toBeLessThanOrEqual(1);

  return { section, topGap, bottomGap, emptyTop };
}

test("Context panel task and artifact empty states have symmetric vertical padding matching members", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 900,
    locale: "en-US",
  });
  await app.waitFor("text:No artifacts yet");

  const tasksEmpty = expectSymmetricEmptyRow(
    app,
    "context-tasks-empty",
    "text:No tasks yet",
  );
  expectSymmetricEmptyRow(app, "context-tasks-no-open", "text:No open tasks");

  // Also verify the action button inside the noOpenTasks empty state row
  // (nth=0 is the ViewAll button inside SectionHeading).
  const noOpenSection = app.layout("id:context-tasks-no-open")!;
  const noOpenEmptyTop = noOpenSection.y + sizes.sectionHeader;
  const noOpenEmptyBottom =
    noOpenSection.y + noOpenSection.height - border.hair;
  const action = app.layout(
    "id:context-tasks-no-open >> label:View all tasks >> nth=1",
  )!;
  expect(action).toBeTruthy();
  expect(action.y).toBeGreaterThanOrEqual(noOpenEmptyTop);
  const actionTopGap = action.y - noOpenEmptyTop;
  const actionBottomGap = noOpenEmptyBottom - (action.y + action.height);
  expect(actionTopGap).toBeGreaterThanOrEqual(space[8] - 1);
  expect(Math.abs(actionTopGap - actionBottomGap)).toBeLessThanOrEqual(1);

  const artifactsEmpty = expectSymmetricEmptyRow(
    app,
    "context-artifacts-empty",
    "text:No artifacts yet",
  );
  const membersEmpty = expectSymmetricEmptyRow(
    app,
    "context-members-empty",
    "text:No members yet",
  );

  expect(tasksEmpty.section.height).toBe(membersEmpty.section.height);
  expect(artifactsEmpty.section.height).toBe(membersEmpty.section.height);
});
