import process from "node:process";

/**
 * The running Bun binary, for commands that must not go through a shell wrapper.
 *
 * On Windows, `bun` on PATH commonly resolves to `bun.cmd`. Bun refuses to pass quoted arguments
 * with cmd.exe special characters to a batch file, which turns build defines into a failed shell
 * command.
 */
export const bunExecutable = (): string => process.execPath;
