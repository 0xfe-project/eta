import type { ReactNode } from "react";
import { use } from "react";
import { InputActiveContext } from "./react";

/**
 * Marks a part of the screen that may or may not receive keys. Scopes nest: a part is active only
 * when every scope around it is. The shell turns off what a layer covers and everything behind
 * the reconnecting screen.
 */
export function InputScope({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const outer = use(InputActiveContext);
  return (
    <InputActiveContext value={outer && active}>{children}</InputActiveContext>
  );
}
