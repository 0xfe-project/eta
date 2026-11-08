/**
 * What the management commands and /artifacts say about themselves: the ops each calls, so a host
 * without one refuses the command as too old before anything is sent, and the /new examples a user
 * can type as they stand.
 */
import { describe, expect, it } from "vitest";
import artifacts from "../../src/ext/artifacts";
import manage from "../../src/ext/manage";

const command = (name: string) =>
  [...(manage.commands ?? []), ...(artifacts.commands ?? [])].find(
    (c) => c.name === name,
  );

describe("/new examples", () => {
  it("give an absolute path, which is what the host takes", () => {
    const paths = (command("new")?.examples ?? [])
      .map((example) => example.input.replace(/^\/new\s*/, ""))
      .filter((path) => path !== "");
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(path).toMatch(/^\//);
  });
});
