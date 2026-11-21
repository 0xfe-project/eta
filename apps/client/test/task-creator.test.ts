import { expect, test } from "nsh/test";
import { uiText } from "../src/i18n";
import { actorLabel, ownerLine } from "../src/pages/tasks/creator";

const user = { kind: "user" as const, agentId: null };
const ada = { kind: "agent" as const, agentId: "ada" };
const known = (id: string | null | undefined) =>
  id === "ada" || id === "zed"
    ? { name: id === "ada" ? "Ada" : "Zed" }
    : undefined;

test("a task made by the user reads as me", () => {
  expect(actorLabel(user, known)).toBe(uiText("taskMe"));
  expect(ownerLine({ createdBy: user, assigneeAgentId: null }, known)).toBe(
    uiText("taskCreatorValue", { name: uiText("taskMe") }),
  );
});

test("a task made by an agent reads as its name, said once when it is also the assignee", () => {
  expect(actorLabel(ada, known)).toBe("Ada");
  const creator = uiText("taskCreatorValue", { name: "Ada" });
  expect(ownerLine({ createdBy: ada, assigneeAgentId: null }, known)).toBe(
    creator,
  );
  expect(ownerLine({ createdBy: ada, assigneeAgentId: "ada" }, known)).toBe(
    creator,
  );
  expect(ownerLine({ createdBy: ada, assigneeAgentId: "zed" }, known)).toBe(
    `Zed · ${creator}`,
  );
});

test("a deleted agent is named as deleted, never as me", () => {
  const gone = { kind: "agent" as const, agentId: "gone" };
  expect(actorLabel(gone, known)).toBe(uiText("taskDeletedAgent"));
  expect(actorLabel(gone, known)).not.toBe(uiText("taskMe"));
  expect(
    ownerLine({ createdBy: gone, assigneeAgentId: null }, known),
  ).toContain(uiText("taskDeletedAgent"));
});
