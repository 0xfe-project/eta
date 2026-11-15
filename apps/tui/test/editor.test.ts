import { describe, expect, it } from "vitest";
import { editorLaunch } from "../src/ui/editor";

const noProgram = () => null;

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

  it("splits the setting on runs of white space", () => {
    expect(
      editorLaunch({
        env: { EDITOR: "  code   --wait\t-n " },
        platform: "linux",
        file,
        which: noProgram,
      }),
    ).toEqual({ command: "code", args: ["--wait", "-n", file] });
  });

  it("keeps quoted parts of the setting together, with either quote, and keeps backslashes", () => {
    expect(
      editorLaunch({
        env: { EDITOR: `"C:\\Program Files\\Ed\\ed.exe" --flag 'a b' c` },
        platform: "linux",
        file,
        which: noProgram,
      }),
    ).toEqual({
      command: "C:\\Program Files\\Ed\\ed.exe",
      args: ["--flag", "a b", "c", file],
    });
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
