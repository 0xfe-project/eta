/** A program to start on the terminal, as `child_process.spawn` takes it. */
export interface ProcessLaunch {
  command: string;
  args: string[];
  /** Pass the arguments to Windows as written: `cmd.exe /s /c` parses its own quotes. */
  windowsVerbatimArguments?: true;
}

/**
 * Splits a command line on white space. Single or double quotes keep a part together and are
 * removed; there are no escapes, so Windows paths keep their backslashes.
 */
function splitCommandLine(text: string): string[] {
  const parts: string[] = [];
  let current: string | undefined;
  let quote: string | undefined;
  for (const char of text) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      current ??= "";
    } else if (/\s/.test(char)) {
      if (current !== undefined) parts.push(current);
      current = undefined;
    } else {
      current = (current ?? "") + char;
    }
  }
  if (current !== undefined) parts.push(current);
  return parts;
}

function editorSetting(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  for (const value of [env.VISUAL, env.EDITOR])
    if (value !== undefined && value.trim() !== "") return value;
  return platform === "win32" ? "notepad" : "vi";
}

/**
 * How to open `file` in the user's editor: `$VISUAL`, then `$EDITOR`, then `notepad` on Windows
 * and `vi` elsewhere. The value may carry arguments. `which` finds a program on `PATH`.
 */
export function editorLaunch(options: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  file: string;
  which: (command: string) => string | null;
}): ProcessLaunch {
  const [command = "", ...args] = splitCommandLine(
    editorSetting(options.env, options.platform),
  );
  const fullArgs = [...args, options.file];
  if (options.platform !== "win32") return { command, args: fullArgs };
  const resolved = options.which(command);
  // Windows starts batch files (`code` is `code.cmd`) only through cmd.exe.
  if (resolved === null || !/\.(?:cmd|bat)$/i.test(resolved))
    return { command, args: fullArgs };
  const line = [resolved, ...fullArgs].map((part) => `"${part}"`).join(" ");
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}
