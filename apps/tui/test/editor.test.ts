import { describe, expect, it } from "vitest";
import { editorLaunch, splitCommandLine } from "../src/ui/editor";

const noProgram = () => null;

describe("splitCommandLine", () => {
  it("splits on runs of white space", () => {
    expect(splitCommandLine("  code   --wait\t-n ")).toEqual([
      "code",
      "--wait",
      "-n",
    ]);
  });

  it("keeps quoted parts together, with either quote", () => {
    expect(
      splitCommandLine(`"C:\\Program Files\\Ed\\ed.exe" --flag 'a b' c`),
    ).toEqual(["C:\\Program Files\\Ed\\ed.exe", "--flag", "a b", "c"]);
  });
});

describe("editorLaunch", () => {
  const file = "/home/u/.eta/tui.json";

  it("prefers VISUAL over EDITOR", () => {
    expect(
      editorLaunch({
        env: { VISUAL: "nano", EDITOR: "vim" },
        platform: "linux",
        file,
        which: noProgram,
      }),
    ).toEqual({ command: "nano", args: [file] });
  });

  it("uses EDITOR when VISUAL is unset or blank", () => {
    expect(
      editorLaunch({
        env: { VISUAL: "  ", EDITOR: "vim -u NONE" },
        platform: "linux",
        file,
        which: noProgram,
      }),
    ).toEqual({ command: "vim", args: ["-u", "NONE", file] });
  });

  it("falls back to vi, and to notepad on Windows", () => {
    expect(
      editorLaunch({ env: {}, platform: "darwin", file, which: noProgram }),
    ).toEqual({ command: "vi", args: [file] });
    expect(
      editorLaunch({ env: {}, platform: "win32", file, which: noProgram }),
    ).toEqual({ command: "notepad", args: [file] });
  });

  it("starts a .cmd editor on Windows through cmd.exe /d /s /c, every part quoted", () => {
    const launch = editorLaunch({
      env: { EDITOR: "code --wait" },
      platform: "win32",
      file: "C:\\Users\\u\\.eta\\tui.json",
      which: (name) =>
        name === "code" ? "C:\\Program Files\\VS Code\\bin\\code.cmd" : null,
    });
    expect(launch).toEqual({
      command: "cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        `""C:\\Program Files\\VS Code\\bin\\code.cmd" "--wait" "C:\\Users\\u\\.eta\\tui.json""`,
      ],
      windowsVerbatimArguments: true,
    });
  });
});
