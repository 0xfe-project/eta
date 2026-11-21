import type { RichCommand } from "nsh/base";
import { chain, setMeta } from "nsh/base";

/**
 * `command` as an undo step of its own: a paste, a block put in or unfolded is undone alone, not
 * with the typing just before it (ProseMirror's history groups changes 500 ms apart).
 */
export function oneStep(command: RichCommand): RichCommand {
  return chain([setMeta("closeHistory$", true), command]);
}
