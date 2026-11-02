import { TaskService } from "@eta/core";
import { Context } from "cordis";
import { describe, expect, it } from "vitest";
import { renderCurrentSteps } from "../src/index";
function withTasks() {
  const ctx = new Context();
  return {
    tasks: new TaskService(ctx),
    dispose: () => void ctx.fiber.dispose(),
  };
}
describe("renderCurrentSteps", () => {
  it("renders all four states with marks", () => {
    const { tasks, dispose } = withTasks();
    const a = tasks.create("pending task");
    const b = tasks.create("doing task");
    tasks.update(b.task.id, { status: "in_progress" });
    const c = tasks.create("done task");
    tasks.update(c.task.id, { status: "completed" });
    const d = tasks.create("killed task");
    tasks.update(d.task.id, { status: "cancelled" });
    const out = renderCurrentSteps(tasks.list());
    expect(out).toBe(
      `<current_steps>\n[ ] ${a.task.id}: pending task\n[~] ${b.task.id}: doing task\n[x] ${c.task.id}: done task\n[-] ${d.task.id}: killed task\n</current_steps>`,
    );
    dispose();
  });
});
