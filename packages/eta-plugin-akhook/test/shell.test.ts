/**
 * `argv` checks: shell commands taken apart with tree-sitter-bash (akhook's `shell.rs` tests,
 * plus the cases the issue names: subshells, pipelines and `sh -c`).
 */
import type { ArgvItem } from "../src/types";
import { describe, expect, it } from "vitest";
import { argvMatches, simpleCommands } from "../src/shell";

const hits = async (pattern: ArgvItem[], script: string): Promise<boolean> =>
  (await simpleCommands(script)).some((words) => argvMatches(pattern, words));

describe("splitting a script into simple commands", () => {
  it("takes lists, pipelines, redirections, assignments and substitutions apart", async () => {
    expect(
      await simpleCommands(
        "cd 'a b' && FOO=1 gh pr create --title \"x y\" > out | cat; echo $(git push)",
      ),
    ).toEqual([
      ["cd", "a b"],
      ["gh", "pr", "create", "--title", "x y"],
      ["cat"],
      ["echo", "$(git push)"],
      ["git", "push"],
    ]);
  });

  it("follows a subshell and a backtick substitution", async () => {
    expect(await simpleCommands("(cd /tmp && rm -rf x) ; echo `date`")).toEqual(
      [["cd", "/tmp"], ["rm", "-rf", "x"], ["echo", "`date`"], ["date"]],
    );
  });

  it("follows the script given to a shell with -c, to a bounded depth", async () => {
    const commands = await simpleCommands(`bash -c "sh -c 'git push --force'"`);
    expect(commands).toContainEqual(["git", "push", "--force"]);
    expect(commands).toContainEqual(["bash", "-c", "sh -c 'git push --force'"]);
    const deep = await simpleCommands(
      `sh -c "sh -c \\"sh -c 'sh -c \\\\\\"sh -c \\\\\\\\\\\\\\"git push\\\\\\\\\\\\\\"\\\\\\"'\\"" `,
    );
    // Nesting beyond the bound is not unpacked: nothing loops, nothing crashes.
    expect(Array.isArray(deep)).toBe(true);
  });

  it("unquotes single, double, ANSI-C and escaped words, and joins concatenations", async () => {
    expect(
      await simpleCommands(`echo 'a b' "c\\"d" $'e\\n' f\\ g h"i"'j'`),
    ).toEqual([["echo", "a b", 'c"d', "e\\n", "f g", "hij"]]);
  });
});

describe("matching argv", () => {
  const create: ArgvItem[] = ["gh", "pr", "create"];

  it("compares the program by basename and the rest in order, not necessarily adjacent", async () => {
    expect(await hits(create, "gh pr create")).toBe(true);
    expect(await hits(create, "/usr/bin/gh -R a/b pr create --fill")).toBe(
      true,
    );
    expect(await hits(create, "cd repo && g\\h 'pr' \"create\"")).toBe(true);
    expect(await hits(create, "gh pr view")).toBe(false);
    expect(await hits(create, "gh create pr")).toBe(false);
  });

  it("does not count words that are only arguments of another program", async () => {
    expect(await hits(create, "echo gh pr create")).toBe(false);
  });

  it("finds the command inside a pipeline, a subshell, a substitution and sh -c", async () => {
    expect(await hits(create, "echo hi | gh pr create")).toBe(true);
    expect(await hits(create, "(gh pr create)")).toBe(true);
    expect(await hits(create, "echo $(gh pr create)")).toBe(true);
    expect(await hits(create, "bash -c 'gh pr create'")).toBe(true);
    expect(await hits(create, `sh -c "cd x && gh pr create"`)).toBe(true);
    expect(await hits(create, "FOO=1 gh pr create > /dev/null 2>&1")).toBe(
      true,
    );
  });

  it("takes a list of alternatives at any position", async () => {
    const any: ArgvItem[] = ["gh", ["pr", "issue"], ["close", "comment"]];
    expect(await hits(any, "gh issue comment 3 -b hi")).toBe(true);
    expect(await hits(any, "gh pr close 4")).toBe(true);
    expect(await hits(any, "gh issue view 3")).toBe(false);
  });

  it("matches a bare program name against its own invocations only", () => {
    expect(argvMatches(["git"], ["git", "status"])).toBe(true);
    expect(argvMatches(["git", "push"], ["git"])).toBe(false);
    expect(argvMatches([], ["git"])).toBe(false);
  });
});
