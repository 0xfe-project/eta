import type {
  SkillFileArgs,
  SkillFileResults,
  SkillTarget,
} from "@eta/client-contracts";
import { getWire } from "@/lib/wire";

type ReaderAction = "list" | "open" | "directory" | "read" | "close";

/** The Web reader only issues read and reader-session calls. */
export function skillCall<A extends ReaderAction>(
  action: A,
  target: SkillTarget,
  input: SkillFileArgs[A],
) {
  return getWire().call<{ target: SkillTarget; result: SkillFileResults[A] }>(
    "skills",
    action,
    { target, input },
    { timeoutMs: 30_000 },
  );
}
